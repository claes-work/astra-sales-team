// Appwrite 2 TablesDB wire contract: https://appwrite.io/docs/references/cloud/server-rest/tablesDB
// This is an allowlisted repository transport, not an arbitrary Appwrite HTTP proxy.
import { isIP } from 'node:net';

const projectId = 'lead-research';
const databases = ['lead-research', 'lead-research-demo'];
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/;
const configuredKeys = ['APPWRITE_ENDPOINT', 'APPWRITE_PROJECT_ID', 'APPWRITE_DATABASE_ID', 'APPWRITE_API_KEY', 'APPWRITE_TRUSTED_HTTP'];

function privateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.internal') || host.endsWith('.localhost')) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(host) === 6) return /^(fc|fd)/.test(host);
  return /^[a-z][a-z0-9-]*$/.test(host); // Explicitly trusted, single-label Docker service.
}

export function appwriteConfiguration(database, env = process.env, { deploymentRoot } = {}) {
  if (!databases.includes(database)) throw new Error('Nur die Vertriebs- oder Demo-Datenbank ist erlaubt.');
  const mode = env.APPWRITE_TRANSPORT?.trim();
  if (mode !== 'rest') throw new Error('Für eigene Daten APPWRITE_TRANSPORT=rest explizit konfigurieren. Anleitung: docs/setup.md. Demo: npm start.');
  const endpoint = env.APPWRITE_ENDPOINT?.trim();
  const key = env.APPWRITE_API_KEY?.trim();
  if (!endpoint || !key || env.APPWRITE_PROJECT_ID !== projectId || env.APPWRITE_DATABASE_ID !== database) {
    throw new Error('REST benötigt vollständige APPWRITE_ENDPOINT/PROJECT_ID/DATABASE_ID/API_KEY-Konfiguration und das ausdrücklich gewählte Vertriebsziel.');
  }
  if (/[\r\n]/.test(key)) throw new Error('Ungültige Appwrite-Zugangskonfiguration.');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Ungültiger Appwrite-Endpunkt.'); }
  if (url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) throw new Error('Appwrite-Endpunkt muss eine Basis-URL mit /v1 ohne Zugangsdaten oder Parameter sein.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && env.APPWRITE_TRUSTED_HTTP === 'true' && privateHost(url.hostname))) {
    throw new Error('Appwrite REST benötigt HTTPS oder ausdrücklich vertrautes privates Container-HTTP.');
  }
  return { mode: 'rest', endpoint: url.href.replace(/\/$/, ''), projectId, database, apiKey: key };
}

export class AppwriteRequestError extends Error {
  constructor(method, { status = null, type = null, uncertain = false } = {}) {
    // Never include response bodies, request data, URLs, credentials or underlying fetch errors.
    super(`Appwrite-Aufruf fehlgeschlagen (${method}${status ? `, HTTP ${status}` : ''}); keine automatische Wiederholung.`);
    this.name = 'AppwriteRequestError';
    this.status = status;
    this.code = status;
    this.type = type;
    this.uncertain = uncertain;
  }
}

function id(value) {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('Ungültige Appwrite-Ressourcen-ID.');
  return encodeURIComponent(value);
}
const pick = (source, keys) => Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
const camelCase = args => Object.fromEntries(Object.entries(args).map(([key, value]) => [key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()), value]));
const listFields = ['queries', 'search', 'total'];
const columnTypes = new Set(['bigint', 'boolean', 'datetime', 'email', 'enum', 'float', 'integer', 'ip', 'longtext', 'mediumtext', 'string', 'text', 'url', 'varchar']);
const columnFields = ['key', 'size', 'required', 'default', 'array', 'min', 'max', 'elements', 'encrypt', 'newKey'];

function route(method, input, database) {
  const a = camelCase(input);
  if (a.databaseId !== undefined && a.databaseId !== database) throw new Error('Appwrite-Aufruf auf eine andere Datenbank verweigert.');
  for (const key of ['tableId', 'rowId', 'transactionId']) if (a[key] !== undefined) id(a[key]);
  const db = `/tablesdb/${id(database)}`;
  const table = () => `${db}/tables/${id(a.tableId)}`;
  const row = () => `${table()}/rows/${id(a.rowId)}`;
  const transaction = () => `/tablesdb/transactions/${id(a.transactionId)}`;
  switch (method) {
    case 'list': return ['GET', '/tablesdb', pick(a, listFields)];
    case 'get': return ['GET', db, {}];
    case 'create': return ['POST', '/tablesdb', { databaseId: database, ...pick(a, ['name', 'enabled']) }];
    case 'update': return ['PUT', db, pick(a, ['name', 'enabled'])];
    case 'list_tables': return ['GET', `${db}/tables`, pick(a, listFields)];
    case 'get_table': return ['GET', table(), {}];
    case 'create_table': return ['POST', `${db}/tables`, pick(a, ['tableId', 'name', 'permissions', 'rowSecurity', 'enabled', 'columns', 'indexes'])];
    case 'update_table': return ['PUT', table(), pick(a, ['name', 'permissions', 'rowSecurity', 'enabled'])];
    case 'list_rows': return ['GET', `${table()}/rows`, pick(a, ['queries', 'transactionId', 'total'])];
    case 'get_row': return ['GET', row(), pick(a, ['queries', 'transactionId'])];
    case 'create_row': return ['POST', `${table()}/rows`, pick(a, ['rowId', 'data', 'permissions', 'transactionId'])];
    case 'update_row': return ['PATCH', row(), pick(a, ['data', 'permissions', 'transactionId'])];
    case 'delete_row': return ['DELETE', row(), pick(a, ['transactionId'])];
    case 'create_transaction': return ['POST', '/tablesdb/transactions', pick(a, ['ttl'])];
    case 'get_transaction': return ['GET', transaction(), {}];
    case 'update_transaction': return ['PATCH', transaction(), pick(a, ['commit', 'rollback'])];
    case 'create_operations': {
      if (!Array.isArray(a.operations) || a.operations.some(op => op.databaseId !== database || !['create', 'update', 'delete', 'upsert', 'increment', 'decrement'].includes(op.action))) {
        throw new Error('Ungültige Transaktionsoperation oder anderes Datenbankziel.');
      }
      for (const op of a.operations) { id(op.tableId); id(op.rowId); }
      return ['POST', `${transaction()}/operations`, { operations: a.operations }];
    }
    case 'list_columns': return ['GET', `${table()}/columns`, pick(a, ['queries', 'total'])];
    case 'get_column': return ['GET', `${table()}/columns/${id(a.key)}`, {}];
    case 'list_indexes': return ['GET', `${table()}/indexes`, pick(a, ['queries', 'total'])];
    case 'get_index': return ['GET', `${table()}/indexes/${id(a.key)}`, {}];
    case 'create_index': return ['POST', `${table()}/indexes`, pick(a, ['key', 'type', 'columns', 'orders', 'lengths'])];
    default: {
      const column = method.match(/^(create|update)_([a-z]+)_column$/);
      if (column && columnTypes.has(column[2])) {
        return [column[1] === 'create' ? 'POST' : 'PATCH', `${table()}/columns/${column[2]}${column[1] === 'update' ? `/${id(a.key)}` : ''}`, pick(a, columnFields)];
      }
      throw new Error('Appwrite-Methode ist in diesem Repository-Adapter nicht freigegeben.');
    }
  }
}

export class AppwriteRestTransport {
  #config;
  #fetch;
  #timeoutMs;
  constructor(config, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    this.#config = config;
    this.#fetch = fetchImpl;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('Ungültiges Appwrite-Zeitlimit.');
    this.#timeoutMs = timeoutMs;
  }
  async call(method, args = {}, write = false) {
    const [verb, path, payload] = route(method, args, this.#config.database);
    const mutation = verb !== 'GET';
    if (mutation && write !== true) throw new Error('Appwrite-Schreibaufruf benötigt eine ausdrückliche Schreiboperation.');
    const url = new URL(this.#config.endpoint + path);
    if (!mutation) {
      for (const [key, value] of Object.entries(payload)) {
        if (Array.isArray(value)) value.forEach((item, index) => url.searchParams.append(`${key}[${index}]`, String(item)));
        else url.searchParams.set(key, String(value));
      }
    }
    let response;
    try {
      response = await this.#fetch(url, {
        method: verb, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { 'X-Appwrite-Project': this.#config.projectId, 'X-Appwrite-Key': this.#config.apiKey,
          'X-Appwrite-Response-Format': '2.0.0', Accept: 'application/json', ...(mutation ? { 'Content-Type': 'application/json' } : {}) },
        ...(mutation ? { body: JSON.stringify(payload) } : {}),
      });
    } catch { throw new AppwriteRequestError(method, { uncertain: mutation }); }
    let body;
    try { body = response.status === 204 ? {} : await response.json(); }
    catch { throw new AppwriteRequestError(method, { status: response.status, uncertain: mutation }); }
    if (!response.ok || body?.error || body?.success === false) {
      const type = ['row_not_found', 'document_not_found', 'document_already_exists', 'row_already_exists', 'database_not_found', 'table_not_found', 'transaction_not_found', 'transaction_conflict', 'user_unauthorized'].includes(body?.type) ? body.type : null;
      throw new AppwriteRequestError(method, { status: response.status, type, uncertain: mutation && response.status >= 500 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppwriteRequestError(method, { status: response.status, uncertain: mutation });
    return body;
  }
}
