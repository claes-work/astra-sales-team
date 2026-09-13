// A public correlation ID, never a credential or an authorization token.
export function outreachLink(url, messageId) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash
    || typeof messageId !== 'string' || !/^msg_[a-f0-9]{28}$/.test(messageId)) throw new Error('Gültige HTTPS-Adresse und persistierte Nachrichten-ID erforderlich.');
  target.searchParams.set('outreach_id', messageId);
  return target.href;
}
