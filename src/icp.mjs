import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import Ajv from 'ajv';

export const defaultProfilePath = fileURLToPath(new URL('../icp/consulting-dach.yaml', import.meta.url));
const schema = JSON.parse(await readFile(new URL('../icp/schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ allErrors: true, allowUnionTypes: true }).compile(schema);

export function resolveProfileValue(profile, path) {
  function walk(value, parts) {
    if (!parts.length) return value;
    const [key, ...rest] = parts;
    if (key === '*') return Array.isArray(value) ? value.map(item => walk(item, rest)).flat() : undefined;
    if (!value || !Object.hasOwn(value, key)) return undefined;
    return walk(value[key], rest);
  }
  return walk(profile, path.split('.'));
}

export function expressionFacts(expression) {
  if (expression.all || expression.any) return [...new Set((expression.all ?? expression.any).flatMap(expressionFacts))];
  if (expression.not) return expressionFacts(expression.not);
  return [expression.fact];
}

export function validateProfile(profile) {
  if (!validate(profile)) {
    throw new Error(`Ungültiges ICP-Profil: ${validate.errors.map(e => `${e.instancePath || '/'} ${e.message}`).join('; ')}`);
  }
  const fail = message => { throw new Error(`Ungültiges ICP-Profil: ${message}`); };
  const unique = (items, label) => {
    if (new Set(items).size !== items.length) fail(`${label} müssen eindeutig sein.`);
  };
  unique(profile.target.region.countries.map(c => c.code), 'Ländercodes');
  unique(profile.target.industries.map(i => i.id), 'Branchen-IDs');
  unique([...profile.qualification.required, ...profile.signals, ...profile.exclusions].map(r => r.id), 'Regel-IDs');
  unique(profile.grading.rules.map(r => r.grade), 'Bewertungsstufen');
  const size = profile.target.companySize;
  if (size.min > size.max || size.excludeBelow > size.min) fail('Unternehmensgrößen sind widersprüchlich.');
  for (const [id, fact] of Object.entries(profile.facts)) {
    if (fact.values?.some(value => typeof value !== fact.type)) fail(`Fakt ${id}: Werte passen nicht zum Typ.`);
  }
  function checkExpression(expression) {
    if (expression.all || expression.any) return (expression.all ?? expression.any).forEach(checkExpression);
    if (expression.not) return checkExpression(expression.not);
    const fact = Object.hasOwn(profile.facts, expression.fact) && profile.facts[expression.fact];
    if (!fact) fail(`Unbekannter Fakt ${expression.fact}.`);
    const value = expression.valueFrom ? resolveProfileValue(profile, expression.valueFrom) : expression.value;
    if (value === undefined) fail(`Unbekannte Referenz ${expression.valueFrom}.`);
    if (expression.op === 'in' ? !Array.isArray(value) || !value.length : Array.isArray(value)) fail(`Fakt ${expression.fact}: Operand passt nicht zum Operator.`);
    const values = Array.isArray(value) ? value : [value];
    if (values.some(v => typeof v !== fact.type)) fail(`Fakt ${expression.fact}: Operand hat falschen Typ.`);
    if (['gte', 'lte', 'gt', 'lt'].includes(expression.op) && fact.type !== 'number') fail(`Fakt ${expression.fact}: Zahlenvergleich erfordert number.`);
    if (fact.values && values.some(v => !fact.values.includes(v))) fail(`Fakt ${expression.fact}: Operand fehlt in values.`);
  }
  [...profile.qualification.required, ...profile.signals, ...profile.exclusions].forEach(rule => checkExpression(rule.when));
  for (const signal of profile.signals) {
    if (signal.event && !expressionFacts(signal.when).includes(signal.event.fact)) fail(`Signal ${signal.id}: Ereignisfakt muss Teil der Bedingung sein.`);
  }
  const ids = new Set(profile.signals.map(s => s.id));
  for (const rule of profile.grading.rules) {
    if (rule.signalIds.some(id => !ids.has(id))) fail(`Bewertung ${rule.grade}: unbekanntes Signal.`);
    if (rule.minMatches > rule.signalIds.length) fail(`Bewertung ${rule.grade}: minMatches ist nicht erreichbar.`);
    if (rule.datedOnly && rule.minMatches < 1) fail(`Bewertung ${rule.grade}: datierte Bewertung benötigt mindestens ein Signal.`);
    if (rule.datedOnly && rule.minMatches > profile.signals.filter(s => rule.signalIds.includes(s.id) && s.event).length) fail(`Bewertung ${rule.grade}: zu wenige datierbare Signale.`);
  }
  const grades = new Set([...profile.grading.rules.map(r => r.grade), profile.grading.fallback]);
  if (profile.enrichment.eligibleGrades.some(g => !grades.has(g))) fail('Enrichment referenziert eine nicht erreichbare Bewertungsstufe.');
  for (const query of profile.discovery.queries) {
    if (/\{[^}]*\}/g.test(query.replaceAll('{city}', '').replaceAll('{country}', ''))) fail('Discovery unterstützt nur {city} und {country}.');
  }
  return profile;
}

export async function loadProfile(path = defaultProfilePath) {
  let source;
  try { source = await readFile(path, 'utf8'); }
  catch { throw new Error(`ICP-Profil konnte nicht gelesen werden: ${path}`); }
  const doc = parseDocument(source, { uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length || doc.warnings.length) throw new Error('Ungültiges ICP-YAML: Syntax, doppelte Schlüssel oder unbekannte Tags prüfen.');
  let profile;
  try { profile = doc.toJS({ maxAliasCount: 0 }); }
  catch { throw new Error('Ungültiges ICP-YAML: Aliase sind nicht erlaubt.'); }
  return validateProfile(profile);
}

export function profileIdentity(profile) {
  return { id: profile.id, version: profile.version, sha256: createHash('sha256').update(JSON.stringify(profile)).digest('hex') };
}

export function buildDiscoveryRequest(profile, { city, country, queryIndex = 0 } = {}) {
  validateProfile(profile);
  const market = country ? profile.target.region.countries.find(c => c.code === country.toUpperCase()) : profile.target.region.countries[0];
  if (!market) throw new Error('Land ist im geladenen ICP-Profil nicht enthalten.');
  if (!Number.isInteger(queryIndex) || !profile.discovery.queries[queryIndex]) throw new Error('Ungültiger Discovery-Suchindex.');
  const selectedCity = city ?? market.defaultCity;
  if (typeof selectedCity !== 'string' || !selectedCity.trim() || selectedCity.length > 100 || /[\x00-\x1f\x7f]/.test(selectedCity)) throw new Error('Stadt muss 1–100 Zeichen ohne Steuerzeichen enthalten.');
  return {
    textQuery: profile.discovery.queries[queryIndex].replaceAll('{city}', selectedCity.trim()).replaceAll('{country}', market.name),
    languageCode: profile.discovery.languageCode,
    regionCode: market.code,
  };
}
