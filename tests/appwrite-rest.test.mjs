import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalAppwrite, LIVE_DB, DEMO_DB, query } from '../src/outreach/appwrite.mjs';
import { appwriteConfiguration, AppwriteRequestError } from '../src/outreach/appwrite-rest.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = overrides => ({ APPWRITE_TRANSPORT: 'rest', APPWRITE_ENDPOINT: 'https://appwrite.example.test/v1',
  APPWRITE_PROJECT_ID: 'lead-research', APPWRITE_DATABASE_ID: LIVE_DB, APPWRITE_API_KEY: 'test-secret-never-in-errors', ...overrides });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function repository(handler = () => json({})) {
  const requests = [];
  const repo = new LocalAppwrite(LIVE_DB, { env: env(), fetchImpl: async (url, options) => {
    const request = { url: new URL(url), ...options, payload: options.body ? JSON.parse(options.body) : null };
    requests.push(request); return handler(request, requests.length);
  } });
  return { repo, requests };
}

test('explicit REST configuration is required; partial or conflicting targets fail closed', () => {
  assert.throws(() => new LocalAppwrite(LIVE_DB, { env: {} }), /APPWRITE_TRANSPORT=rest/);
  assert.throws(() => new LocalAppwrite(DEMO_DB, { env: {} }), /APPWRITE_TRANSPORT=rest/);
  for (const invalid of [env({ APPWRITE_TRANSPORT: undefined }), env({ APPWRITE_API_KEY: '' }),
    env({ APPWRITE_PROJECT_ID: 'another-project' }), env({ APPWRITE_DATABASE_ID: DEMO_DB }),
    env({ APPWRITE_TRANSPORT: 'other' }), env({ APPWRITE_API_KEY: 'bad\nkey' })]) {
    assert.throws(() => new LocalAppwrite(LIVE_DB, { env: invalid }));
  }
  assert.throws(() => new LocalAppwrite('arbitrary-db', { env: {} }));
});

test('HTTPS is required except explicitly trusted private container HTTP', () => {
  for (const endpoint of ['https://api.example.test/v1', 'https://api.example.test/v1/']) {
    assert.equal(appwriteConfiguration(LIVE_DB, env({ APPWRITE_ENDPOINT: endpoint })).endpoint, 'https://api.example.test/v1');
  }
  for (const host of ['appwrite-sales', 'appwrite.internal', '127.0.0.1:8088', '10.4.5.6', '172.20.0.3', '192.168.1.7', '[::1]']) {
    assert.equal(appwriteConfiguration(LIVE_DB, env({ APPWRITE_ENDPOINT: `http://${host}/v1`, APPWRITE_TRUSTED_HTTP: 'true' })).mode, 'rest');
  }
  for (const endpoint of ['http://appwrite/v1', 'ftp://api.example.test/v1', 'https://user:secret@api.example.test/v1',
    'https://api.example.test/v1?token=secret', 'https://api.example.test/v1#other', 'https://api.example.test/other', 'not-a-url']) {
    assert.throws(() => appwriteConfiguration(LIVE_DB, env({ APPWRITE_ENDPOINT: endpoint })));
  }
  for (const host of ['203.0.113.10', '169.254.169.254', '172.32.0.1', 'api.example.test']) {
    assert.throws(() => appwriteConfiguration(LIVE_DB, env({ APPWRITE_ENDPOINT: `http://${host}/v1`, APPWRITE_TRUSTED_HTTP: 'true' })));
  }
});

test('connect actually authenticates to the configured database; redirects cannot forward the key', async () => {
  const { repo, requests } = repository(() => json({ $id: LIVE_DB }));
  assert.equal(await repo.connect(), repo);
  assert.equal(requests[0].url.pathname, '/v1/tablesdb/lead-research');
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].redirect, 'error');
  assert.equal(requests[0].headers['X-Appwrite-Project'], 'lead-research');
  assert.equal(requests[0].headers['X-Appwrite-Key'], env().APPWRITE_API_KEY);
  assert.equal(requests[0].headers['X-Appwrite-Response-Format'], '2.0.0');
  assert.ok(requests[0].signal instanceof AbortSignal);
  await repo.close();
  await assert.rejects(repository(() => json({ $id: 'wrong-db' })).repo.connect(), /Falsches/);
});

test('list retrieves all pages in stable ID order and flattens both Appwrite row shapes', async () => {
  const rows = Array.from({ length: 203 }, (_, i) => ({ $id: `row_${String(i).padStart(3, '0')}`, data: { name: `Firma ${i}` } }));
  rows[202] = { $id: 'row_202', name: 'Already flat' };
  const { repo, requests } = repository(({ url }) => {
    const queries = [...url.searchParams.values()].map(value => JSON.parse(value));
    const offset = queries.find(q => q.method === 'offset').values[0];
    assert.deepEqual(queries.find(q => q.method === 'equal'), { method: 'equal', attribute: 'client_id', values: ['own'] });
    assert.deepEqual(queries.find(q => q.method === 'orderAsc'), { method: 'orderAsc', attribute: '$id', values: [] });
    return json({ rows: rows.slice(offset, offset + 100), total: rows.length });
  });
  const result = await repo.list('companies', [query('equal', ['own'], 'client_id')]);
  assert.equal(result.length, 203);
  assert.deepEqual(result[0], { $id: 'row_000', name: 'Firma 0' });
  assert.equal(result[202].name, 'Already flat');
  assert.equal(requests.length, 3);
  assert.ok(requests[0].url.searchParams.has('queries[0]'));
});

test('page requests only its requested window and rejects incomplete responses', async () => {
  const { repo, requests } = repository(() => json({ rows: [{ $id: 'abc', data: { value: 2 } }], total: 51 }));
  assert.deepEqual(await repo.page('companies', { page: 3, pageSize: 25 }), { rows: [{ $id: 'abc', value: 2 }], total: 51 });
  const queries = [...requests[0].url.searchParams.values()].map(JSON.parse);
  assert.equal(queries.find(q => q.method === 'offset').values[0], 50);
  assert.equal(queries.find(q => q.method === 'limit').values[0], 25);
  await assert.rejects(repo.page('companies', { page: 0 }));
  await assert.rejects(repo.page('companies', { pageSize: 101 }));
  await assert.rejects(repository(() => json({ rows: [], total: 'unknown' })).repo.page('companies'), /unvollständig/);
  await assert.rejects(repository(() => json({ total: 2 })).repo.list('companies'), /unvollständig/);
});

test('get is a direct read; only a proven missing row becomes null', async () => {
  const { repo, requests } = repository(() => json({ $id: 'id_1', data: { company_name: 'ÄÖÜ', $id: 'untrusted' }, $createdAt: '2026-09-12T12:00:00Z' }));
  assert.deepEqual(await repo.get('companies', 'id_1'), { $id: 'id_1', company_name: 'ÄÖÜ', $createdAt: '2026-09-12T12:00:00Z' });
  assert.equal(requests[0].url.pathname, '/v1/tablesdb/lead-research/tables/companies/rows/id_1');
  assert.equal(await repository(() => json({ type: 'row_not_found' }, 404)).repo.get('companies', 'missing'), null);
  await assert.rejects(repository(() => json({ type: 'table_not_found' }, 404)).repo.get('companies', 'missing'), { status: 404 });
  await assert.rejects(repository(() => json({ type: 'user_unauthorized' }, 401)).repo.get('companies', 'missing'), { status: 401 });
});

test('create/update preserve exact IDs, JSON field names, data and timestamps without transport retries', async () => {
  const { repo, requests } = repository(({ payload }) => json({ $id: payload.rowId ?? 'saved_id', ...payload.data }));
  const data = { company_id: 'firm_1', details_json: '{"stage":0}', created_at: '2026-09-10T07:00:00Z' };
  await repo.create('outreach_events', 'saved_id', data);
  await repo.update('outreach_events', 'saved_id', { details_json: '{"stage":1}' });
  assert.deepEqual(requests[0].payload, { rowId: 'saved_id', data, permissions: [] });
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[1].method, 'PATCH');
  assert.deepEqual(requests[1].payload, { data: { details_json: '{"stage":1}' } });
  assert.equal(requests.length, 2);
});

test('schema provisioning routes pass batch columns/indexes untouched and map snake_case only at top level', async () => {
  const { repo, requests } = repository(() => json({}));
  const columns = [{ key: 'is_test', type: 'boolean', required: true }];
  const indexes = [{ key: 'source_submission', type: 'unique', attributes: ['source_submission_id'] }];
  await repo.call('create_table', { database_id: LIVE_DB, table_id: 'quiz_submissions', name: 'Quiz', row_security: false, permissions: [], columns, indexes }, true);
  await repo.call('create_varchar_column', { database_id: LIVE_DB, table_id: 'quiz_submissions', key: 'contact_email', required: false, size: 320 }, true);
  await repo.call('create_index', { database_id: LIVE_DB, table_id: 'quiz_submissions', key: 'submission', type: 'unique', columns: ['source_submission_id'] }, true);
  assert.deepEqual(requests[0].payload, { tableId: 'quiz_submissions', name: 'Quiz', permissions: [], rowSecurity: false, columns, indexes });
  assert.equal(requests[1].url.pathname, '/v1/tablesdb/lead-research/tables/quiz_submissions/columns/varchar');
  assert.deepEqual(requests[1].payload, { key: 'contact_email', size: 320, required: false });
  assert.deepEqual(requests[2].payload.columns, ['source_submission_id']);
});

test('raw calls cannot change project, database, path or silently perform a write', async () => {
  const { repo, requests } = repository();
  await assert.rejects(repo.call('get_table', { database_id: DEMO_DB, table_id: 'companies' }));
  await assert.rejects(repo.call('create_row', { table_id: 'companies', row_id: 'id', data: {} }));
  await assert.rejects(repo.call('get_row', { table_id: 'companies', row_id: '../other' }));
  await assert.rejects(repo.call('create_table', { table_id: '../bad' }, true));
  await assert.rejects(repo.call('delete', { database_id: LIVE_DB }, true));
  await assert.rejects(repo.raw('appwrite_call_tool', { tool_name: 'users_list', project_id: 'lead-research' }));
  await assert.rejects(repo.raw('appwrite_call_tool', { tool_name: 'tables_db_list', project_id: 'other' }));
  await assert.rejects(repo.call('create_operations', { transaction_id: 'tx', operations: [{ action: 'create', databaseId: DEMO_DB, tableId: 'companies', rowId: 'id', data: {} }] }, true));
  assert.equal(requests.length, 0);
});

test('transactions stage in 50-operation batches and commit only after every successful stage', async () => {
  const { repo, requests } = repository(() => json({ $id: 'transaction_1' }));
  const operations = Array.from({ length: 101 }, (_, i) => ({ action: 'create', table: 'outreach_events', id: `event_${i}`, data: { source: 'website' } }));
  await repo.transaction(operations);
  assert.equal(requests.length, 5);
  assert.equal(requests[0].url.pathname, '/v1/tablesdb/transactions');
  assert.deepEqual(requests[0].payload, { ttl: 300 });
  assert.deepEqual(requests.slice(1, 4).map(r => r.payload.operations.length), [50, 50, 1]);
  assert.deepEqual(requests[1].payload.operations[0], { action: 'create', databaseId: LIVE_DB, tableId: 'outreach_events', rowId: 'event_0', data: { source: 'website' } });
  assert.equal(requests[4].method, 'PATCH');
  assert.deepEqual(requests[4].payload, { commit: true });
});

test('transaction failure rolls back once, never commits or automatically restages', async () => {
  const { repo, requests } = repository((_, index) => index === 2 ? json({ type: 'transaction_conflict', message: 'private details' }, 409) : json({ $id: 'tx_1' }));
  await assert.rejects(repo.transaction([{ action: 'create', table: 'outreach_events', id: 'event_1', data: {} }]), /nicht bestätigt/);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].payload, { rollback: true });
  assert.ok(requests.every(r => !r.payload.commit));
});

test('API and network errors do not expose credentials, response PII or underlying request details', async () => {
  for (const status of [401, 409, 429, 503]) {
    const { repo, requests } = repository(() => json({ message: `${env().APPWRITE_API_KEY} private@example.test`, type: 'row_already_exists' }, status));
    await assert.rejects(repo.create('outreach_events', 'event_1', {}), error => {
      assert.ok(error instanceof AppwriteRequestError);
      assert.equal(error.status, status);
      assert.equal(error.uncertain, status >= 500);
      assert.doesNotMatch(String(error), /test-secret|private@example/);
      return true;
    });
    assert.equal(requests.length, 1);
  }
  const { repo, requests } = repository(() => { throw new Error(`fetch leaked ${env().APPWRITE_API_KEY}`); });
  await assert.rejects(repo.create('outreach_events', 'event_1', {}), error => error.uncertain && !String(error).includes('test-secret'));
  assert.equal(requests.length, 1);
});
