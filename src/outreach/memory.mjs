// Ephemeral demo repository. No persistence and no external database connection.
import { DEMO_DB } from './appwrite.mjs';
import { salesSchema } from '../../infra/appwrite/schema.mjs';
import { outreachTables } from '../../infra/appwrite/outreach-schema.mjs';
import { websiteQuizTables } from '../../infra/appwrite/website-quiz-schema.mjs';

export class MemoryRepository {
  constructor() { this.database = DEMO_DB; this.rows = new Map(); }
  async close() {}
  async call(method) {
    if (method === 'list') return { databases: [{ $id: this.database }] };
    if (method === 'list_tables') return { tables: [...salesSchema.tables, ...outreachTables, ...websiteQuizTables].map(table => ({
      $id: table.id, rowSecurity: false, $permissions: [],
      columns: table.columns.map(column => ({ ...column, status: 'available' })),
      indexes: table.indexes.map(index => ({ ...index, status: 'available' })),
    })) };
    throw new Error(`Demo unterstützt keine Schemaänderung: ${method}`);
  }
  async list(table, filters = []) {
    let rows = [...this.rows].filter(([key]) => key.startsWith(`${table}/`)).map(([, row]) => structuredClone(row));
    for (const encoded of filters) {
      const { method, attribute, values } = JSON.parse(encoded);
      if (method === 'equal') rows = rows.filter(row => values.includes(row[attribute]));
      else if (method === 'orderAsc') rows.sort((a, b) => String(a[attribute] ?? '').localeCompare(String(b[attribute] ?? '')));
      else if (method !== 'select') throw new Error(`Nicht unterstützte Demo-Abfrage: ${method}`);
    }
    return rows;
  }
  async page(table, { page = 1, pageSize = 20, filters = [] } = {}) {
    const rows = await this.list(table, filters);
    return { total: rows.length, rows: rows.slice((page - 1) * pageSize, page * pageSize) };
  }
  async get(table, id) { return structuredClone(this.rows.get(`${table}/${id}`) ?? null); }
  async create(table, id, data) {
    const key = `${table}/${id}`;
    if (this.rows.has(key)) throw new Error('Zeile existiert bereits.');
    const now = new Date().toISOString();
    const row = { ...structuredClone(data), $id: id, $createdAt: now, $updatedAt: now };
    this.rows.set(key, row); return structuredClone(row);
  }
  async update(table, id, data) {
    const old = await this.get(table, id);
    if (!old) throw new Error('Zeile fehlt.');
    const row = { ...old, ...structuredClone(data), $updatedAt: new Date().toISOString() };
    this.rows.set(`${table}/${id}`, row); return structuredClone(row);
  }
  async transaction(operations) {
    const before = structuredClone(this.rows);
    try {
      for (const op of operations) {
        if (!['create', 'update'].includes(op.action)) throw new Error('Ungültige Demo-Operation.');
        await this[op.action](op.table, op.id, op.data);
      }
    } catch (error) { this.rows = before; throw error; }
  }
}
