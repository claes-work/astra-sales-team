import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { email, identity } from './experiment.mjs';
import { withReplySyncLock } from './lock.mjs';

const maxBytes = 262144;
const parseMail = source => simpleParser(source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true });
const refs = value => (Array.isArray(value) ? value : [value ?? '']).flatMap(v => String(v).match(/<[^<>\s]+>/g) ?? []);

export function matchReply(parsed, messages, enrollments) {
  const direct = refs(parsed.inReplyTo);
  const references = direct.length ? direct : refs(parsed.references).reverse();
  let candidates = [];
  for (const reference of references) {
    candidates = messages.filter(m => m.provider_message_id === reference && ['sent', 'sending'].includes(m.status));
    if (candidates.length) break;
  }
  if (candidates.length !== 1 || parsed.from?.value?.length !== 1) return null;
  const message = candidates[0];
  const enrollment = enrollments.find(e => e.message_id === message.$id);
  if (!enrollment) return null;
  const snapshot = JSON.parse(enrollment.snapshot_json);
  let from;
  try { from = email(parsed.from.value[0].address); } catch { return null; }
  const recipients = [...(parsed.to?.value ?? []), ...(parsed.cc?.value ?? [])].map(v => v.address?.toLowerCase());
  if (from !== message.target_address || !recipients.some(address => [snapshot.replyTo, snapshot.sender.email].includes(address))) return null;
  return message;
}

export async function importReply({ service, source, origin, receivedAt }) {
  if (!Buffer.isBuffer(source) || source.length > maxBytes) throw new Error('Antwortdatei fehlt oder überschreitet 256 KiB. Große Nachrichten manuell prüfen.');
  const parsed = await parseMail(source);
  const message = matchReply(parsed, await service.repo.list('outreach_messages'), await service.repo.list('outreach_enrollments'));
  if (!message || !parsed.messageId) return { matched: false, reason: 'Keine eindeutige Referenz mit passendem Absender und Empfänger; kein Inhalt gespeichert.' };
  const automatic = parsed.headers.get('auto-submitted');
  const type = automatic && String(automatic).toLowerCase() !== 'no' ? 'auto_reply' : 'reply_received';
  const time = receivedAt ?? (parsed.date && Number.isFinite(parsed.date.getTime()) ? parsed.date.toISOString() : service.now().toISOString());
  const result = await service.recordOutcome({ messageId: message.$id, type, occurredAt: time, sourceId: parsed.messageId,
    source: origin, note: String(parsed.text ?? '').slice(0, 20000) });
  return { matched: true, messageId: message.$id, type, ...result, needsHumanClassification: type === 'reply_received' };
}

export async function syncReplies(options) {
  return (options.lock ?? withReplySyncLock)(() => syncRepliesUnlocked(options));
}

async function syncRepliesUnlocked({ service, env, clientFactory = options => new ImapFlow(options) }) {
  const host = env.OUTREACH_IMAP_HOST?.trim();
  const user = email(env.OUTREACH_IMAP_USER);
  if (host !== 'imap.hostinger.com' || !env.OUTREACH_IMAP_PASSWORD) throw new Error('Hostinger-IMAP ist noch nicht konfiguriert. Kein Verbindungsversuch.');
  const folder = env.OUTREACH_IMAP_FOLDER?.trim() || 'INBOX';
  if (folder.length > 255 || /[\x00-\x1f]/.test(folder)) throw new Error('Ungültiger Postfachordner.');
  const stateId = identity('syn', host, user, folder);
  const stored = await service.repo.get('outreach_sync_state', stateId);
  const previous = stored ? JSON.parse(stored.state_json) : { lastUid: 0, uidValidity: null };
  const client = clientFactory({ host, port: 993, secure: true, tls: { rejectUnauthorized: true },
    auth: { user, pass: env.OUTREACH_IMAP_PASSWORD }, logger: false, logRaw: false, disableAutoIdle: true,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
  let mailboxLock;
  let scanned = 0, matched = 0, oversized = 0;
  let cursor = previous.lastUid;
  try {
    await client.connect();
    mailboxLock = await client.getMailboxLock(folder, { readOnly: true });
    const validity = String(client.mailbox.uidValidity);
    if (previous.uidValidity && previous.uidValidity !== validity) throw new Error('Postfach-UIDVALIDITY hat sich geändert. Lesestand manuell neu aufsetzen; kein stiller Datenverlust.');
    const attempts = await service.repo.list('outreach_attempts');
    const earliest = attempts.map(a => Date.parse(a.attempted_at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    // On first connection with no outreach history, establish a baseline instead
    // of traversing the user's historical inbox. Existing attempts start at their day.
    if (!stored && earliest === undefined) cursor = Math.max(0, Number(client.mailbox.uidNext) - 1);
    const since = previous.since ?? new Date(earliest ?? service.now().getTime()).toISOString();
    const allUids = (await client.search({ uid: `${cursor + 1}:*`, since: new Date(since) }, { uid: true }) || []).filter(uid => uid > cursor).sort((a, b) => a - b);
    const batch = allUids.slice(0, 100);
    const messages = await service.repo.list('outreach_messages');
    const enrollments = await service.repo.list('outreach_enrollments');
    // Inspect reference headers first; fetch a body only for an unambiguous sales reply.
    for (const uid of batch) {
      const header = await client.fetchOne(String(uid), { uid: true, size: true, internalDate: true,
        headers: ['message-id', 'in-reply-to', 'references', 'from', 'to', 'cc', 'date', 'auto-submitted'] }, { uid: true });
      if (!header) { cursor = uid; scanned++; continue; }
      const parsed = await parseMail(header.headers);
      const linked = matchReply(parsed, messages, enrollments);
      if (linked) {
        if (header.size > maxBytes) {
          // Keep a durable review item before advancing past a large reply.
          await service.recordOutcome({ messageId: linked.$id, type: 'review_note',
            occurredAt: new Date(header.internalDate).toISOString(), source: `imap:${host}:${user}:${folder}`,
            sourceId: `oversized:${validity}:${uid}`, note: `Zugeordnete Antwort über 256 KiB; im Postfach manuell prüfen. UID ${uid}. Kein Inhalt importiert.` });
          oversized++;
        }
        else {
          const full = await client.fetchOne(String(uid), { source: { maxLength: maxBytes + 1 } }, { uid: true });
          if (!full?.source) throw new Error('Zugeordnete Antwort konnte nicht vollständig geladen werden.');
          const imported = await importReply({ service, source: full.source, origin: `imap:${host}:${user}:${folder}`,
            receivedAt: new Date(header.internalDate).toISOString() });
          if (imported.matched) matched++;
        }
      }
      cursor = uid; scanned++;
    }
    // Save only after all selected messages succeeded. A crash replays stable message IDs.
    const state = { provider: 'hostinger-imap', updated_at: service.now().toISOString(),
      state_json: JSON.stringify({ lastUid: cursor, uidValidity: validity, since, oversizedLastRun: oversized }) };
    if (stored) await service.repo.update('outreach_sync_state', stateId, state);
    else await service.repo.create('outreach_sync_state', stateId, state);
    return { scanned, matched, oversized, remaining: Math.max(0, allUids.length - batch.length), readOnly: true,
      note: oversized ? 'Große zugeordnete Antworten im Postfach manuell prüfen; Inhalt nicht importiert.' : null };
  } catch (error) {
    if (error.message?.includes('UIDVALIDITY')) throw error;
    throw new Error('Antwortabgleich nicht abgeschlossen. Verbindung, Zugang und gespeicherten Lesestand prüfen; keine Postfachänderung vorgenommen.');
  } finally {
    mailboxLock?.release();
    try { await client.logout(); } catch { client.close(); }
  }
}
