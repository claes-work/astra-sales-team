export function activeFilters(query) { return ['fit', 'outreach', 'blocked', 'positive', 'research'].filter(k => query[k] !== undefined && query[k] !== '').length; }
export function filterResetUrl(query) { const params = new URLSearchParams(); if (query.q) params.set('q', query.q); return `/leads${params.size ? `?${params}` : ''}`; }
export function conciseReason(reason) {
  if (!reason) return 'Noch nicht bewertet.';
  return reason.replace('Pflichtmerkmale belegt; kein aktueller datierter A-Trigger erforderlich.', 'Die erforderlichen Merkmale der Zielgruppe sind belegt.').replace('Kein ICP-Fit: Ausschluss oder verletztes Pflichtkriterium.', 'Mindestens ein Ausschlussgrund oder eine nicht erfüllte Voraussetzung.').replace(/A-Trigger/g, 'aktueller Rechercheanlass');
}
export function recordedRate(rate, kind = 'reply') {
  if (!rate || rate.denominatorUnit !== 'companies' || typeof rate.recordedValue !== 'number' || !Number.isFinite(rate.recordedValue) || rate.recordedValue <= 0 || rate.recordedValue > 1 || !Number.isInteger(rate.numerator) || !Number.isInteger(rate.denominator) || rate.denominator <= 0 || rate.numerator <= 0 || rate.numerator > rate.denominator || Math.abs(rate.recordedValue - rate.numerator / rate.denominator) > 0.000001) return null;
  const title = {reply:'Erfasste E-Mail-Quote',positive:'Erfasste Positivquote',meeting:'Erfasste Terminquote'}[kind];
  if (!title) return null;
  return `${title}: ${new Intl.NumberFormat('de-DE', {style:'percent',maximumFractionDigits:1}).format(rate.recordedValue)} · ${rate.numerator}/${rate.denominator} Firmen`;
}

// The overview is a reaction feed; the complete audit history stays on detail pages.
// Compact overview entries omit booking/provider evidence, so verify only those
// candidate reactions against their existing message timeline. Fail closed.
export async function overviewFeedback(entries, readMessage) {
  const messages = new Map();
  const replies = new Set(['reply_received','reply_positive','reply_negative','reply_neutral','reply_question']);
  const selected = await Promise.all((Array.isArray(entries) ? entries : []).map(async entry => {
    if (entry.origin === 'lead_activity') return entry.type === 'conversation_positive' ? entry : null;
    if (entry.origin !== 'outreach_event') return null;
    if (replies.has(entry.type)) return entry;
    if (!['meeting_booked','unsubscribed'].includes(entry.type) || !entry.messageId) return null;
    if (!messages.has(entry.messageId)) messages.set(entry.messageId, Promise.resolve().then(() => readMessage(entry.messageId)).catch(() => null));
    const message = await messages.get(entry.messageId);
    const event = message?.timeline?.find(e => e.id === entry.id && e.origin === 'outreach_event' && e.type === entry.type);
    if (!event) return null;
    const details = event.details || {};
    if (entry.type === 'meeting_booked') return typeof details.booking?.id === 'string' && details.booking.id.trim() && typeof details.booking?.evidence === 'string' && details.booking.evidence.trim() ? entry : null;
    return details.provider === 'brevo' && ['unsubscribe','unsubscribed'].includes(details.rawEvent) ? entry : null;
  }));
  return selected.filter(Boolean);
}
