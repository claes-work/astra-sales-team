import { syncReplies } from './inbound.mjs';
import { configurationStatus } from './brevo.mjs';
import { dayContext } from './service.mjs';
import { dayKey } from '../operations/time.mjs';

export async function workerCycle({ service, env, execute = false, replySync = syncReplies }) {
  if (typeof execute !== 'boolean') throw new Error('execute muss ausdrücklich true oder false sein.');
  const config = configurationStatus(env);
  const result = { sync: {}, send: null };
  // Sync first. Any failed sync stops the cycle before new mail can be sent.
  if (config.apiKeyPresent) result.sync.provider = await service.syncProvider({ maxMessages: 20 });
  else result.sync.provider = { skipped: 'Brevo noch nicht verbunden.' };
  if (config.imapConfigured) result.sync.replies = await replySync({ service, env });
  else result.sync.replies = { skipped: 'Antwortpostfach noch nicht verbunden.' };
  if (!execute) { result.send = { skipped: 'Nur Abgleich; kein Versand angefordert.' }; return result; }
  const controls = await service.repo.get('outreach_controls', 'default');
  if (controls?.paused) { result.send = { skipped: 'Versand pausiert.' }; return result; }
  if (!config.apiKeyPresent || !config.imapConfigured || !config.sendEnabled)
    throw new Error('Automatischer Versand braucht konfigurierte Versand- und Antwortverbindung sowie lokale Aktivierung.');
  const now = service.now();
  const day = dayContext(now, controls.timezone);
  if (day.hour < controls.start_hour || day.hour >= controls.end_hour || (controls.weekdays_only && day.weekend)) {
    result.send = { skipped: 'Außerhalb des Versandfensters.' }; return result;
  }
  const attempts = await service.repo.list('outreach_attempts');
  if (Math.max(attempts.filter(a => dayKey(a.attempted_at) === dayKey(now)).length,
    attempts.filter(a=>now-new Date(a.attempted_at)<86400000).length) >= controls.daily_limit) {
    result.send = { skipped: 'Limit für Berliner Tag oder rollierende 24 Stunden erreicht.' }; return result;
  }
  if (attempts.some(a => now - new Date(a.attempted_at) < controls.min_interval_seconds * 1000)) {
    result.send = { skipped: 'Mindestabstand seit letztem Versandversuch.' }; return result;
  }
  const experiments = await service.repo.list('outreach_experiments');
  const enrollments = await service.repo.list('outreach_enrollments');
  const active = new Set(experiments.filter(e => e.status === 'active').map(e => e.$id));
  const candidates = new Set(enrollments.filter(e => active.has(e.experiment_id)).map(e => e.message_id));
  const message = (await service.repo.list('outreach_messages')).find(m => m.status === 'approved' && candidates.has(m.$id));
  if (!message) { result.send = { skipped: 'Keine freigegebene Nachricht.' }; return result; }
  result.send = await service.sendOne({ messageId: message.$id, execute: true });
  return result;
}

export async function watchWorker(options, intervalSeconds = 180) {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 3600) throw new Error('Abgleichintervall muss zwischen 60 und 3600 Sekunden liegen.');
  let stopped = false, timer, wake;
  const stop = () => { stopped = true; clearTimeout(timer); wake?.(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    while (!stopped) {
      try { console.log(JSON.stringify(await workerCycle(options))); }
      catch (error) {
        // Fail closed and exit; a failed sync must not become an unattended send loop.
        throw new Error(`Hintergrundlauf angehalten: ${error.message}`);
      }
      if (!stopped) await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, intervalSeconds * 1000); });
    }
  } finally { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
