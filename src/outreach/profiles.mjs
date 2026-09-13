import Ajv from 'ajv';
import { readFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { hash, hasTemplateExpression } from './experiment.mjs';

const text = (maxLength = 2000) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const line = (maxLength = 500) => ({ ...text(maxLength), pattern: '^[^\\x00-\\x1f\\x7f]+$' });
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const list = (items, maxItems = 20) => ({ type: 'array', minItems: 1, maxItems, uniqueItems: true, items });
export const profileRefSchema = object({ key: { ...line(80), pattern: '^[a-z0-9-]{1,80}$' }, version: line(40) });
const base = { schemaVersion: { const: 1 }, ...profileRefSchema.properties, name: line(512) };
const iso = line(40);
export const strategySchema = object({ ...base,
  readiness: { enum: ['draft', 'ready'] }, hypothesis: text(), objective: text(),
  primaryMetric: { const: 'qualified_meeting_rate' },
  freeBenefit: text(), tone: text(), salutationRule: text(), contentFunctions: list(text()),
  research: object({ requireCompletedEnrichment: { type: 'boolean' }, maxEvidenceAgeDays: { type: 'integer', minimum: 1, maximum: 3650 },
    rules: list(text()) }),
  boundaries: list(text()), preferredAction: { enum: ['reply', 'link', 'undecided'] },
  humanChecks: list(object({ id: { ...line(50), pattern: '^[a-z0-9-]+$' }, instruction: text() })),
});
export const personalizationSchema = object({ ...base, strategy: profileRefSchema, experiment: profileRefSchema,
  assessmentId: line(36), contactId: { anyOf: [line(36), { type: 'null' }] }, recipientName: line(512), recipientSourceUrl: line(2048), salutation: line(),
  observation: object({ text: text(), evidenceIds: list(line(36), 10) }),
  relevance: text(), body: text(20000), question: text(),
  action: object({ kind: { enum: ['reply', 'link'] }, text: text(), url: { anyOf: [{ type: 'string', maxLength: 2048 }, { type: 'null' }] } }),
  hypothesis: object({ status: { const: 'unconfirmed' }, text: text() }),
  authorship: object({ author: line(255), methodVersion: line(80), model: { anyOf: [line(255), { type: 'null' }] } }),
  subjects: object({ a: line(500), b: line(500) }),
  checkedAt: iso,
  review: object({ status: { enum: ['needs_research', 'pending', 'approved'] }, by: { type: 'string', maxLength: 255 },
    checkedAt: { type: 'string', maxLength: 40 }, checks: { type: 'array', uniqueItems: true, maxItems: 20, items: line(50) },
    note: { type: 'string', maxLength: 4000 }, approvedContentHash: { type: 'string', maxLength: 64 } }),
});
// Optional newly researched sources travel with this draft; original assessment evidence is never edited.
personalizationSchema.properties.supplementalEvidence = { type: 'array', maxItems: 10, items: object({
  id: line(36), sourceUrl: line(2048), sourceQuote: text(4000), observedAt: iso, checkedBy: line(255),
  excerptKind: { enum: ['quote', 'summary'] },
}) };
const ajv = new Ajv({ allErrors: true });
const validators = { strategy: ajv.compile(strategySchema), personalization: ajv.compile(personalizationSchema) };
export function validateProfile(kind, definition) {
  const validate = validators[kind];
  if (!validate || !validate(definition)) throw new Error(`Ungültiges ${kind}-Profil: ` + (validate?.errors ?? []).map(e => `${e.instancePath} ${e.message}`).join('; '));
  if (kind === 'strategy' && new Set(definition.humanChecks.map(c => c.id)).size !== definition.humanChecks.length) throw new Error('Prüfpunkte brauchen eindeutige Kennungen.');
  if (kind === 'personalization') {
    timestamp(definition.checkedAt);
    const recipientSource = new URL(definition.recipientSourceUrl);
    if (!['https:', 'http:'].includes(recipientSource.protocol) || recipientSource.username || recipientSource.password) throw new Error('Quelle zur Ansprechperson fehlt oder ist ungültig.');
    if (definition.subjects.a === definition.subjects.b) throw new Error('Firmenspezifische Betreffvorschläge müssen verschieden sein.');
    if (definition.review.status === 'approved' && (!definition.review.by.trim() || !definition.review.note.trim())) throw new Error('Menschliche Prüfung braucht Prüfer und Begründung.');
    if (definition.review.status === 'approved') timestamp(definition.review.checkedAt);
    if (definition.review.status === 'approved' && definition.body.includes('[FUNNEL_LINK_OFFEN]')) throw new Error('Offener Funnel-Link verhindert redaktionelle Freigabe.');
    if (definition.review.status === 'approved' && definition.review.approvedContentHash !== reviewContentHash(definition)) throw new Error('Review gehört nicht zu diesem Mailinhalt. Inhalt erneut redaktionell prüfen.');
    if (!definition.body.includes(definition.salutation) || !definition.body.includes(definition.action.text)) throw new Error('Vollständiger Body muss die deklarierte Anrede und Handlung enthalten.');
    if (definition.action.kind === 'link') {
      if (definition.action.url === null) {
        if (definition.review.status === 'approved' || !definition.body.includes('[FUNNEL_LINK_OFFEN]')) throw new Error('Offener Funnel-Link ist nur im ungeprüften Entwurf mit sichtbarer Kennzeichnung erlaubt.');
      } else {
        const url = new URL(definition.action.url);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || !definition.body.includes(url.href) || definition.body.includes('[FUNNEL_LINK_OFFEN]')) throw new Error('Link-CTA braucht eine passende HTTPS-Adresse im Body ohne offenen Link-Marker.');
      }
    } else if (definition.action.url !== '') throw new Error('Antwort-CTA hat keine zusätzliche Zieladresse.');
  }
  // Profiles contain data, never executable or recursively expanded templates.
  if (hasTemplateExpression(definition)) throw new Error('Profilwerte dürfen keine Template-Ausdrücke enthalten.');
  return definition;
}
export function timestamp(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Gültiger Zeitpunkt mit Zeitzone erforderlich.');
  return new Date(value).toISOString();
}
export function contentHash(value) {
  const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
  return hash(JSON.stringify(canonical(value)));
}
export function reviewContentHash(definition) { const { review, ...authored } = definition; return contentHash(authored); }
export async function loadContentFile(path) {
  if (!path) throw new Error('Dateipfad fehlt.');
  const source = await readFile(path, 'utf8');
  if (Buffer.byteLength(source) > 65536) throw new Error('Profildatei größer als 64 KiB.');
  return parse(source, { maxAliasCount: 20 });
}
export const exportContent = definition => stringify(definition);
