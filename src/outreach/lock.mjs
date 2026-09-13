import { mkdir, open, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { withProcessLock } from './process-lock.mjs';

const directory = fileURLToPath(new URL('../../.local/outreach/', import.meta.url));
// Separate from message mutations: importing a reply takes the operation lock.
export const withReplySyncLock = work => withOutreachLock(work, join(directory, 'imap'));
// One shared local lock for CLI, API and worker, across both databases.
// A crash leaves the lock in place deliberately; review uncertain sends first.
export async function withOutreachLock(work, folder = directory) {
  if (process.env.OUTREACH_LOCK_MODE === 'flock') {
    const base = process.env.OUTREACH_LOCK_DIR;
    if (!base) throw new Error('Produktionssperrverzeichnis fehlt.');
    const suffix = folder === directory ? 'operation.flock' : 'imap.flock';
    return withProcessLock(work, join(base, suffix));
  }
  await mkdir(folder, { recursive: true });
  let handle;
  const path = join(folder, 'operation.lock');
  try { handle = await open(path, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Eine Outreach-Operation läuft oder hinterließ eine Sperre. Prozess und Versandversuche prüfen; nicht parallel starten.');
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await work();
  } finally { await handle.close(); await unlink(path); }
}
