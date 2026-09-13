import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { LocalAppwrite, LIVE_DB } from '../src/outreach/appwrite.mjs';
import { loadOutreachEnv } from '../src/outreach/brevo.mjs';
import { provision } from '../src/outreach/provision.mjs';

export async function initializeDatabase(repo) {
  const result = await repo.call('list', {});
  if (!Array.isArray(result.databases)) throw new Error('Appwrite-Datenbankliste ist unvollständig.');
  if (!result.databases.some(database => database.$id === repo.database)) {
    await repo.call('create', { database_id: repo.database, name: 'Sales Team' }, true);
  }
  await repo.connect();
  return provision(repo);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--execute') {
    console.error('Legt Schema in deiner konfigurierten Appwrite-Instanz an: npm run db:init -- --execute. Zuerst docs/setup.md lesen.');
    process.exitCode = 1;
  } else {
    try {
      const repo = new LocalAppwrite(LIVE_DB, { env: loadOutreachEnv() });
      console.log(JSON.stringify(await initializeDatabase(repo), null, 2));
      await repo.close();
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
