import { berlinInstant } from './format.mjs';

export function leadQuery(params = {}) {
  const one = k => typeof params[k] === 'string' ? params[k] : '';
  const bounded = (v, fallback, max) => /^\d+$/.test(v) ? Math.max(1, Math.min(max, Number(v))) : fallback;
  const choose = (k, choices, fallback = '') => choices.includes(one(k)) ? one(k) : fallback;
  return {
    page: String(bounded(one('page'), 1, 100000)), pageSize: String(bounded(one('pageSize'), 20, 100)),
    q: one('q').trim().slice(0, 200),
    fit: choose('fit', ['qualified', 'excluded', 'not_qualified', 'needs_review', 'unreviewed']),
    outreach: choose('outreach', ['sent', 'draft', 'unsent', 'accepted']), blocked: choose('blocked', ['true', 'false']),
    positive: choose('positive', ['true']), research: choose('research', ['unreviewed', 'reviewed', 'enriched']),
    sort: choose('sort', ['name_asc', 'name_desc', 'research_desc', 'created_desc'], 'name_asc'),
  };
}
export function validId(value) { return typeof value === 'string' && /^[\w-]{1,100}$/.test(value); }
export function activityInput(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Ungültige Eingabe.');
  const allowed = ['companyId', 'type', 'channel', 'localTime', 'offset', 'sourceId', 'note', 'by', 'messageId'];
  if (Object.keys(raw).some(k => !allowed.includes(k))) throw new Error('Unbekannte Eingabefelder.');
  if (!validId(raw.companyId) || !validId(raw.sourceId) || (raw.messageId && !validId(raw.messageId))) throw new Error('Ungültige Referenz.');
  if (!['note', 'conversation_positive', 'do_not_contact'].includes(raw.type)) throw new Error('Bitte eine gültige Rückmeldung wählen.');
  if (!['phone', 'email', 'other'].includes(raw.channel)) throw new Error('Bitte eine Quelle wählen.');
  if (typeof raw.by !== 'string' || !raw.by.trim() || raw.by.length > 120) throw new Error('Bitte deinen Namen angeben (maximal 120 Zeichen).');
  if (typeof raw.note !== 'string' || !raw.note.trim() || raw.note.length > 4000) throw new Error('Bitte eine kurze Notiz angeben (maximal 4.000 Zeichen).');
  const occurredAt = berlinInstant(raw.localTime, raw.offset || 'auto');
  if (Date.parse(occurredAt) > now + 60000) throw new Error('Die Rückmeldung darf nicht in der Zukunft liegen.');
  return { companyId: raw.companyId, type: raw.type, channel: raw.channel, occurredAt,
    sourceId: raw.sourceId, source: 'sales-dashboard', note: raw.note.trim(), by: raw.by.trim(), ...(raw.messageId ? { messageId: raw.messageId } : {}) };
}
export function localRequestAllowed(headers, port = '3000', mutation = false) {
  const host = headers.get('host');
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (headers.get('x-forwarded-host') && headers.get('x-forwarded-host') !== host) return false;
  const origin = headers.get('origin');
  if (origin && origin !== `http://${host}`) return false;
  if (mutation && origin !== `http://${host}`) return false;
  const site = headers.get('sec-fetch-site');
  return !site || site === 'same-origin' || (!mutation && site === 'none');
}
