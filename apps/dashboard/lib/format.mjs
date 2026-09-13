export const TIMEZONE = 'Europe/Berlin';
export function count(value) { return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('de-DE').format(value) : '—'; }
export function date(value, withTime = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Unbekannt';
  return new Intl.DateTimeFormat('de-DE', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(new Date(value));
}
export function dayLabel(value) { return date(`${value}T12:00:00Z`); }
export function localMinute(value = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function berlinInstant(value, offset = 'auto') {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Bitte ein gültiges Datum mit Uhrzeit angeben.');
  if (!['auto', '+01:00', '+02:00'].includes(offset)) throw new Error('Ungültiger Zeitversatz.');
  const candidates = ['+01:00', '+02:00'].filter(o => offset === 'auto' || offset === o).map(o => new Date(`${value}:00${o}`)).filter(d => Number.isFinite(d.getTime()) && localMinute(d) === value);
  if (!candidates.length) throw new Error('Diese Uhrzeit gibt es in Berlin nicht oder der Zeitversatz passt nicht. Bitte prüfen.');
  if (candidates.length > 1) throw new Error('Diese Uhrzeit kommt bei der Zeitumstellung zweimal vor. Bitte Sommerzeit oder Winterzeit auswählen.');
  return candidates[0].toISOString();
}
export function safeWebsite(value) { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : null; } catch { return null; } }
export function sentTime(message) {
  if (!message.sentAt) return 'Versandzeit nicht belegt';
  return `${date(message.sentAt, true)}${message.sentAtIsProxy ? ' · Zustellzeit; Versandzeit unbekannt' : ''}`;
}
export function proxyNote(counts) {
  return typeof counts?.sentTimeProxyMessages === 'number' && counts.sentTimeProxyMessages > 0
    ? `${count(counts.sentTimeProxyMessages)} davon dem Zustelltag zugeordnet; der tatsächliche Versandtag ist unbekannt.`
    : 'Versandzeit nach vorhandenem Ereignisbeleg.';
}
export function duration(value, measured = true) {
  if (!measured || typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'Noch nicht erfasst';
  const number = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${number.format(value / 1000)} Sek.`;
  return `${number.format(value / 60000)} Min.`;
}
export const labels = {
  qualified: 'Passend', excluded: 'Ausgeschlossen', not_qualified: 'Nicht passend', needs_review: 'Prüfung offen', unreviewed: 'Neu · ungeprüft', qualification_replay: 'Erneute Regelbewertung',
  reviewed: 'Geprüft', researched: 'Recherchiert', checked: 'Geprüft', enriched: 'Angereichert', pending: 'Offen', completed: 'Abgeschlossen', unknown: 'Unbekannt',
  sent: 'Versand belegt', unsent: 'Nicht angeschrieben', draft: 'Entwurf', approved: 'Freigegeben', sending: 'Versand ungeklärt', accepted: 'Anbieter angenommen', blocked: 'Gesperrt',
  provider_accepted: 'Anbieterauftrag angenommen', provider_sent: 'Versand vom Anbieter gemeldet', delivered: 'Zustellung gemeldet', opened: 'Öffnung gemeldet', clicked: 'Linkklick gemeldet',
  request: 'Anbieterauftrag', deferred: 'Verzögert', soft_bounce: 'Vorübergehender Zustellfehler', hard_bounce: 'Dauerhafter Zustellfehler', invalid_email: 'Ungültige Adresse', error: 'Anbieterfehler', complaint: 'Beschwerde', spam: 'Spam gemeldet', unsubscribed: 'Abmeldung',
  reply_received: 'E-Mail-Antwort erfasst', reply_positive: 'Positive E-Mail-Antwort', reply_negative: 'Negative E-Mail-Antwort', reply_neutral: 'Neutrale E-Mail-Antwort',
  conversation_positive: 'Positive Rückmeldung', note: 'Notiz', review_note: 'Prüfnotiz', do_not_contact: 'Kontaktsperre',
  meeting_booked: 'Terminbuchung', meeting_qualified: 'Gespräch qualifiziert', meeting_disqualified: 'Gespräch nicht qualifiziert', meeting_held: 'Gespräch geführt', meeting_cancelled: 'Termin abgesagt', workshop_won: 'Workshop gewonnen', quiz_completed: 'Quiz abgeschlossen',
  phone: 'Telefon', email: 'E-Mail', other: 'Manuell', manual: 'Manuell', brevo: 'Brevo', demo: 'Simulierter Testanbieter', discovery: 'Kandidatensuche', qualification: 'Qualifizierung', enrichment: 'Anreicherung', drafting: 'Texterstellung', approval: 'Freigabe', research: 'Recherche', search: 'Suche', evidence: 'Belegrecherche', authoring: 'Texterstellung', running: 'Läuft', failed: 'Fehlgeschlagen', cancelled: 'Abgebrochen', skipped: 'Ausgelassen', proxy_open: 'Automatischer Öffnungsabruf gemeldet', provider_error: 'Anbieterfehler', provider_other: 'Weiteres Anbietersignal', reply_question: 'Rückfrage per E-Mail', auto_reply: 'Automatische Antwort',
};
export function label(value) { return labels[value] || value || 'Unbekannt'; }
export function researchLabel(value) {
  return ({ unreviewed: 'Neu · ungeprüft', assessed: 'Geprüft', pending: 'Anreicherung offen', completed: 'Angereichert', skipped: 'Anreicherung ausgelassen', failed: 'Anreicherung fehlgeschlagen' })[value] || label(value);
}
