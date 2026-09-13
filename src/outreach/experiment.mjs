import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import Ajv from 'ajv';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const identity = (prefix, ...values) => `${prefix}_${hash(values).slice(0, 28)}`;
export const hasTemplateExpression = value => typeof value === 'string' ? /\{\{|\}\}/.test(value)
  : value && typeof value === 'object' ? Object.values(value).some(hasTemplateExpression) : false;
const validate = new Ajv({ allErrors: true }).compile({ type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'key', 'version', 'name', 'variable', 'landingUrl', 'responseWindowDays', 'variants', 'body'],
  properties: { schemaVersion: { const: 1 }, key: { type: 'string', pattern: '^[a-z0-9-]{1,80}$' }, version: { type: 'string', minLength: 1, maxLength: 40 },
    name: { type: 'string', minLength: 1, maxLength: 512 }, variable: { const: 'subject' }, landingUrl: { type: 'string', maxLength: 2048 },
    responseWindowDays: { type: 'integer', minimum: 1, maximum: 90 }, body: { type: 'string', minLength: 1, maxLength: 20000 },
    variants: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'object', additionalProperties: false, required: ['id', 'subject'],
      properties: { id: { type: 'string', pattern: '^[a-z0-9_-]{1,50}$' }, subject: { type: 'string', minLength: 1, maxLength: 500 } } } } } });

export const individualExperimentSchema = { type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'key', 'version', 'name', 'authoring', 'strategy', 'hypothesis', 'variable', 'enrollmentWindow', 'responseWindowDays', 'variants'],
  properties: {
    schemaVersion: { const: 2 }, key: { type: 'string', pattern: '^[a-z0-9-]{1,80}$' }, version: { type: 'string', minLength: 1, maxLength: 40 },
    name: { type: 'string', minLength: 1, maxLength: 512 }, authoring: { const: 'individual' }, variable: { const: 'subject' },
    hypothesis: { type: 'string', minLength: 1, maxLength: 2000 },
    strategy: { type: 'object', additionalProperties: false, required: ['key', 'version'], properties: {
      key: { type: 'string', pattern: '^[a-z0-9-]{1,80}$' }, version: { type: 'string', minLength: 1, maxLength: 40 } } },
    responseWindowDays: { type: 'integer', minimum: 1, maximum: 90 },
    enrollmentWindow: { type: 'object', additionalProperties: false, required: ['startsAt', 'endsAt'],
      properties: { startsAt: { type: 'string', maxLength: 40 }, endsAt: { type: 'string', maxLength: 40 } } },
    variants: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'object', additionalProperties: false, required: ['id', 'name', 'subjectMethod'],
      properties: { id: { enum: ['a', 'b'] }, name: { type: 'string', minLength: 1, maxLength: 200 }, subjectMethod: { type: 'string', minLength: 1, maxLength: 2000 } } } },
  } };
const validateIndividual = new Ajv({ allErrors: true }).compile(individualExperimentSchema);

export function validateExperiment(definition) {
  if (definition?.schemaVersion === 2) {
    if (!validateIndividual(definition)) throw new Error('Ungültiges individuelles Experiment: ' + validateIndividual.errors.map(e => `${e.instancePath} ${e.message}`).join('; '));
    const { startsAt, endsAt } = definition.enrollmentWindow;
    if ([startsAt, endsAt].some(t => !/(Z|[+-]\d\d:\d\d)$/.test(t) || !Number.isFinite(Date.parse(t))) || Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error('Gemeinsames Testfenster mit gültigen Zeitpunkten erforderlich.');
    if (new Set(definition.variants.map(v => v.id)).size !== 2 || new Set(definition.variants.map(v => v.subjectMethod.trim())).size !== 2) throw new Error('Zwei verschiedene Betreffmethoden a/b erforderlich.');
    if (hasTemplateExpression(definition)) throw new Error('Individuelle Experimente enthalten Methoden, keine Textplatzhalter.');
    return definition;
  }
  if (!validate(definition)) throw new Error('Ungültige Experimentdatei: ' + validate.errors.map(e => `${e.instancePath} ${e.message}`).join('; '));
  const url = new URL(definition.landingUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Die Zielseite braucht eine feste HTTPS-URL ohne Zugangsdaten oder Fragment.');
  if (new Set(definition.variants.map(v => v.id)).size !== 2 || new Set(definition.variants.map(v => v.subject)).size !== 2) throw new Error('Zwei unterschiedliche Varianten erforderlich.');
  for (const template of [definition.body, ...definition.variants.map(v => v.subject)]) {
    if (/{{(?!\s*(company|senderName|landingUrl)\s*}})/.test(template)) throw new Error('Unbekannter Textplatzhalter.');
  }
  if (definition.variants.some(v => /[\r\n\x00-\x1f]/.test(v.subject))) throw new Error('Betreff enthält Steuerzeichen.');
  return definition;
}
export async function loadExperiment(path) { return validateExperiment(parse(await readFile(path, 'utf8'))); }
export function render(definition, variantId, { company, senderName, personalization }) {
  const variant = definition.variants.find(v => v.id === variantId);
  if (definition.schemaVersion === 2) {
    if (!variant || !personalization?.subjects?.[variantId] || !personalization.body?.trim()) throw new Error('Vollständiger individueller Mailentwurf fehlt.');
    const subject = personalization.subjects[variantId];
    if (subject.length > 1024 || /[\r\n\x00-\x1f\x7f]/.test(subject) || /\{\{|\}\}/.test(subject + personalization.body)) throw new Error('Unsichere individuelle Textwerte.');
    return { subject, body: personalization.body };
  }
  if (!variant || !company?.trim() || !senderName?.trim() || /[\r\n\x00-\x1f]/.test(company + senderName)) throw new Error('Ungültige Textwerte oder Variante.');
  const values = { company, senderName, landingUrl: definition.landingUrl };
  const fill = template => template.replace(/{{\s*(company|senderName|landingUrl)\s*}}/g, (_, key) => values[key]);
  const subject = fill(variant.subject);
  if (subject.length > 1024) throw new Error('Gerenderter Betreff ist zu lang.');
  return { subject, body: fill(definition.body) };
}
export function assignVariant(definition, seed, clientId, companyId) {
  // Firm-level stable random assignment; actual small samples need not be exactly balanced.
  const bucket = parseInt(hash([seed, clientId, companyId]).slice(0, 8), 16) % 2;
  return definition.variants[bucket].id;
}
export function email(value) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(result) || result.length > 320 || /[\x00-\x1f\x7f]/.test(result)) throw new Error('Ungültige E-Mail-Adresse.');
  return result;
}
