import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

export function loadOutreachEnv() {
  try { loadEnvFile(fileURLToPath(new URL('../../.env.local', import.meta.url))); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Lokale Konfiguration nicht lesbar.'); }
  return process.env;
}

export function configurationStatus(env) {
  return { provider: 'brevo', apiKeyPresent: Boolean(env.BREVO_API_KEY?.trim()),
    senderConfigured: Boolean(env.OUTREACH_SENDER_EMAIL?.trim() && env.OUTREACH_SENDER_NAME?.trim()),
    replyToConfigured: Boolean(env.OUTREACH_REPLY_TO_EMAIL?.trim()), sendEnabled: env.OUTREACH_SEND_ENABLED === 'true',
    imapConfigured: Boolean(env.OUTREACH_IMAP_USER?.trim() && env.OUTREACH_IMAP_PASSWORD),
    liveVerified: false };
}

export class ProviderError extends Error {
  constructor(message, uncertain = false, status = null) { super(message); this.uncertain = uncertain; this.status = status; }
}

export class BrevoProvider {
  constructor({ env = {}, fetchImpl = fetch } = {}) { this.env = env; this.fetch = fetchImpl; this.name = 'brevo'; }
  async request(path, { method = 'GET', body } = {}) {
    const key = this.env.BREVO_API_KEY?.trim();
    if (!key || /[\s\x00-\x1f]/.test(key)) throw new ProviderError('Brevo-API-Schlüssel fehlt oder hat ein ungültiges Format.');
    // Fixed vendor origin, no caller-provided URLs, no redirects, no implicit retries.
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Ungültiger Anbieterpfad.');
    let response;
    try {
      response = await this.fetch(`https://api.brevo.com/v3${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': key },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new ProviderError('Brevo-Anfrage nicht bestätigt; keine automatische Wiederholung.', method === 'POST'); }
    if (!response.ok) {
      // Never expose raw provider errors, request headers, credentials or reflected content.
      throw new ProviderError(`Brevo HTTP ${response.status}. Zugang, Freigabe oder Kontingent prüfen.`, method === 'POST' && response.status >= 500, response.status);
    }
    try { return await response.json(); }
    catch { throw new ProviderError('Brevo-Antwort nicht lesbar; Zustand vor Wiederholung abgleichen.', method === 'POST'); }
  }
  async verify() {
    const account = await this.request('/account');
    const result = await this.request('/senders');
    const sender = result.senders?.find(s => s.email?.toLowerCase() === this.env.OUTREACH_SENDER_EMAIL?.trim().toLowerCase());
    return { connected: true, senderPresent: Boolean(sender), senderActive: sender?.active === true,
      smtpEnabled: account.relay?.enabled === true, domainAndInboxTested: false };
  }
  async send(message, attemptId) {
    const escape = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const html = message.body.split(/(https:\/\/[^\s<>"']+)/g).map(part => /^https:\/\//.test(part)
      ? `<a href="${escape(part)}">${escape(part)}</a>` : escape(part)).join('');
    const payload = { sender: message.sender, to: [{ email: message.to }], replyTo: { email: message.replyTo },
      subject: message.subject, textContent: message.body,
      htmlContent: `<html><body><div style="white-space:pre-wrap">${html}</div></body></html>`,
      tags: [attemptId], headers: { 'Idempotency-Key': attemptId } };
    const result = await this.request('/smtp/email', { method: 'POST', body: payload });
    if (typeof result.messageId !== 'string' || !result.messageId || result.messageId.length > 255)
      throw new ProviderError('Brevo lieferte keine eindeutige Nachrichtenkennung; Versandstatus unklar.', true);
    return { messageId: result.messageId };
  }
  async events({ messageId, tag, days = 30 } = {}) {
    if (!messageId && !tag) throw new Error('Ereignisse brauchen eine Nachrichtenreferenz.');
    const all = [];
    // Query one known message/attempt, never scrape the whole account history.
    for (let offset = 0; offset < 5000; offset += 100) {
      const params = new URLSearchParams({ limit: '100', offset: String(offset), days: String(days), sort: 'asc' });
      if (messageId) params.set('messageId', messageId);
      else params.set('tags', JSON.stringify([tag]));
      const page = await this.request(`/smtp/statistics/events?${params}`);
      // The documented events property is optional for an empty report.
      if (page && typeof page === 'object' && !Array.isArray(page) && page.events === undefined && !page.error && !page.code) return all;
      if (!Array.isArray(page.events)) throw new ProviderError('Brevo-Ereignisliste unvollständig.');
      all.push(...page.events);
      if (page.events.length < 100) return all;
    }
    throw new ProviderError('Ereignisgrenze erreicht; kein vollständiger Abgleich.');
  }
}
