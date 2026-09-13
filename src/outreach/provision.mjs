import { salesSchema } from '../../infra/appwrite/schema.mjs';
import { outreachTables, defaultControls } from '../../infra/appwrite/outreach-schema.mjs';
import { websiteQuizTables } from '../../infra/appwrite/website-quiz-schema.mjs';
import { DEMO_DB } from './appwrite.mjs';

export async function provision(repo) {
  const dbs = await repo.call('list', {});
  if (!dbs.databases?.some(db => db.$id === repo.database)) {
    if (repo.database !== DEMO_DB) throw new Error('Zuerst die lokale Vertriebsdatenbank einrichten.');
    await repo.call('create', { database_id: repo.database, name: 'Vertrieb – isolierte Software-Demo' }, true);
  }
  const expected = [...salesSchema.tables, ...outreachTables, ...websiteQuizTables];
  const existing = await repo.call('list_tables', { database_id: repo.database, queries: [JSON.stringify({ method: 'limit', values: [100] })] });
  const created = [];
  for (const table of expected) {
    let actual = existing.tables?.find(t => t.$id === table.id);
    if (!actual) {
      actual = await repo.call('create_table', { database_id: repo.database, table_id: table.id, name: table.name,
        permissions: [], row_security: false, columns: table.columns, indexes: table.indexes }, true);
      created.push(table.id);
    }
    if (actual.rowSecurity !== false || actual.$permissions?.length !== 0) throw new Error(`Unerwartete Tabellenrechte: ${table.id}`);
    for (const column of table.columns) {
      const found = actual.columns?.find(c => c.key === column.key);
      if (!found || found.status !== 'available' || (found.format || found.type) !== column.type
        || ['size', 'required', 'min', 'max', 'elements'].some(k => k in column && JSON.stringify(found[k]) !== JSON.stringify(column[k])))
        throw new Error(`Schemaabweichung: ${table.id}.${column.key}. Keine automatische Änderung.`);
    }
    for (const index of table.indexes) {
      const found = actual.indexes?.find(i => i.key === index.key);
      if (!found || found.status !== 'available' || found.type !== index.type || JSON.stringify(found.columns ?? found.attributes) !== JSON.stringify(index.attributes))
        throw new Error(`Indexabweichung: ${table.id}.${index.key}`);
    }
  }
  if (!await repo.get('outreach_controls', 'default')) await repo.create('outreach_controls', 'default', defaultControls);
  return { database: repo.database, created, paused: (await repo.get('outreach_controls', 'default')).paused };
}
