import { appwriteConfiguration, AppwriteRestTransport } from './appwrite-rest.mjs';

export const LIVE_DB = 'lead-research';
export const DEMO_DB = 'lead-research-demo';
const project = 'lead-research';
export const query = (method, values, attribute) => JSON.stringify({ method, ...(attribute ? { attribute } : {}), values });
const flatten = row => ({ ...(row.data ?? {}), ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'data')) });

export class LocalAppwrite {
  constructor(database = LIVE_DB, { env = process.env, fetchImpl, timeoutMs, deploymentRoot } = {}) {
    this.database = database;
    const config = appwriteConfiguration(database, env, { deploymentRoot });
    this.deploymentRoot = deploymentRoot;
    this.mode = config.mode;
    if (config.mode === 'rest') this.rest = new AppwriteRestTransport(config, { fetchImpl, timeoutMs });
  }
  async connect() {
    const database = await this.call('get', { database_id: this.database });
    if (database.$id !== this.database) throw new Error('Falsches Appwrite-Datenbankziel.');
    return this;
  }
  async close() {}
  async raw(name, args) {
    if (name !== 'appwrite_call_tool' || args.project_id !== project || !args.tool_name?.startsWith('tables_db_')) throw new Error('Nur konfigurierte TablesDB-Aufrufe sind über REST erlaubt.');
    return this.rest.call(args.tool_name.slice('tables_db_'.length), args.arguments, args.confirm_write);
  }
  async call(method, args, write = false) {
    return this.raw('appwrite_call_tool', { tool_name: `tables_db_${method}`, arguments: args, project_id: project, confirm_write: write });
  }
  async list(table, filters = []) {
    const rows = [];
    for (let page = 0; page < 1000; page++) {
      const result = await this.call('list_rows', { database_id: this.database, table_id: table,
        queries: [...filters, query('limit', [100]), query('offset', [page * 100]), query('orderAsc', [], '$id')] });
      if (!Array.isArray(result.rows)) throw new Error('Appwrite-Zeilenliste unvollständig.');
      rows.push(...result.rows.map(flatten));
      if (result.rows.length < 100) return rows;
    }
    throw new Error('Abfragegrenze erreicht; Ergebnis nicht vollständig.');
  }
  async get(table, id) {
    if (this.rest) {
      try { return flatten(await this.call('get_row', { database_id: this.database, table_id: table, row_id: id })); }
      catch (error) {
        if (error.status === 404 && ['row_not_found', 'document_not_found'].includes(error.type)) return null;
        throw error;
      }
    }
    const rows = await this.list(table, [query('equal', [id], '$id')]);
    return rows[0] ?? null;
  }
  async page(table, { page = 1, pageSize = 20, filters = [] } = {}) {
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('Ungültige Seite.');
    const result = await this.call('list_rows', {database_id:this.database,table_id:table,queries:[...filters,query('limit',[pageSize]),query('offset',[(page-1)*pageSize]),query('orderAsc',[],'$id')]});
    if (!Array.isArray(result.rows) || !Number.isInteger(result.total) || result.total < 0) throw new Error('Appwrite-Zeilenseite unvollständig.');
    return {total:result.total,rows:result.rows.map(flatten)};
  }
  async create(table, id, data) {
    return flatten(await this.call('create_row', { database_id: this.database, table_id: table, row_id: id, data, permissions: [] }, true));
  }
  async update(table, id, data) {
    return flatten(await this.call('update_row', { database_id: this.database, table_id: table, row_id: id, data }, true));
  }
  async transaction(operations) {
    if (!operations.length) return;
    const transaction = await this.call('create_transaction', { ttl: 300 }, true);
    try {
      for (let i = 0; i < operations.length; i += 50) {
        await this.call('create_operations', { transaction_id: transaction.$id, operations: operations.slice(i, i + 50).map(op => ({
          action: op.action, databaseId: this.database, tableId: op.table, rowId: op.id, data: op.data,
        })) }, true);
      }
      await this.call('update_transaction', { transaction_id: transaction.$id, commit: true }, true);
    } catch {
      await this.call('update_transaction', { transaction_id: transaction.$id, rollback: true }, true).catch(() => {});
      throw new Error('Datenbank-Transaktion nicht bestätigt. Vor Wiederholung Zustand lesen.');
    }
  }
}
