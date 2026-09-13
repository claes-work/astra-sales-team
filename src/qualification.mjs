import { expressionFacts, profileIdentity, resolveProfileValue, validateProfile } from './icp.mjs';

const DAY = 86_400_000;
const sourceTypes = new Set(['website', 'registry', 'job_board', 'social', 'news', 'manual', 'google_places']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;

export function dateNumber(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const date = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value ? date : NaN;
}

export function validateEvidence(profile, evidence) {
  if (!Array.isArray(evidence)) throw new Error('Recherchebelege müssen eine Liste sein.');
  evidence.forEach((item, index) => {
    const fail = message => { throw new Error(`Beleg ${index + 1}: ${message}`); };
    if (!isObject(item)) fail('Objekt erwartet.');
    if (Object.keys(item).some(k => !['fact', 'value', 'confidence', 'source', 'observedAt', 'eventDate'].includes(k))) fail('Unbekanntes Feld.');
    if (!Object.hasOwn(profile.facts, item.fact)) fail('Unbekannte Fakt-ID im geladenen Profil.');
    const definition = profile.facts[item.fact];
    if (typeof item.value !== definition.type || (definition.type === 'number' && !Number.isFinite(item.value))) fail('Wert passt nicht zum Fakt-Typ.');
    if (definition.type === 'string' && !isText(item.value)) fail('Leerer Fakt-Wert.');
    if (definition.values && !definition.values.includes(item.value)) fail('Wert ist im Profil nicht erlaubt.');
    if (!['confirmed', 'inferred'].includes(item.confidence)) fail('confidence muss confirmed oder inferred sein.');
    if (!Number.isFinite(dateNumber(item.observedAt))) fail('observedAt muss ein gültiges Datum YYYY-MM-DD sein.');
    if (item.eventDate !== undefined && !Number.isFinite(dateNumber(item.eventDate))) fail('eventDate muss ein gültiges Datum YYYY-MM-DD sein.');
    if (!isObject(item.source) || Object.keys(item.source).some(k => !['type', 'url', 'quote'].includes(k)) || !sourceTypes.has(item.source.type) || !isText(item.source.quote)) fail('Quelle benötigt type, url und einen konkreten Belegtext in quote.');
    try {
      const url = new URL(item.source.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Ungültige Quellen-URL.');
    } catch { fail('Quelle benötigt eine vollständige HTTP(S)-URL ohne Zugangsdaten.'); }
  });
}

// Fehlende, widersprüchliche, unbestätigte oder veraltete Belege sind unbekannt.
// Insbesondere darf NOT(unknown) niemals zu einem bewiesenen Merkmal werden.
function evaluate(expression, profile, facts) {
  if (expression.all || expression.any) {
    const all = Boolean(expression.all);
    const children = (expression.all ?? expression.any).map(child => evaluate(child, profile, facts));
    const decisive = all ? false : true;
    const selected = children.filter(child => child.state === decisive);
    const state = selected.length ? decisive : children.some(child => child.state === null) ? null : !decisive;
    const proof = (selected.length ? selected : children).flatMap(child => child.evidenceIndexes);
    return { state, evidenceIndexes: [...new Set(proof)] };
  }
  if (expression.not) {
    const result = evaluate(expression.not, profile, facts);
    return { ...result, state: result.state === null ? null : !result.state };
  }
  const fact = facts[expression.fact];
  if (fact.state !== 'known') return { state: null, evidenceIndexes: [] };
  const expected = expression.valueFrom ? resolveProfileValue(profile, expression.valueFrom) : expression.value;
  const actual = fact.value;
  const operators = {
    eq: () => actual === expected, ne: () => actual !== expected,
    in: () => expected.includes(actual), gte: () => actual >= expected,
    lte: () => actual <= expected, lt: () => actual < expected, gt: () => actual > expected,
  };
  return { state: operators[expression.op](), evidenceIndexes: fact.evidenceIndexes };
}

export function qualifyLead({ profile, lead, evidence = [], asOf = new Date().toISOString().slice(0, 10) }) {
  validateProfile(profile);
  if (!isObject(lead) || !isText(lead.id)) throw new Error('Lead benötigt eine eindeutige id.');
  const today = dateNumber(asOf);
  if (!Number.isFinite(today)) throw new Error('asOf muss ein gültiges Datum YYYY-MM-DD sein.');
  validateEvidence(profile, evidence);
  const factFindings = Object.fromEntries(Object.keys(profile.facts).map(id => [id, { state: 'unknown', evidenceIndexes: [], ignored: [] }]));
  evidence.forEach((item, index) => {
    const age = (today - dateNumber(item.observedAt)) / DAY;
    const reason = item.source.type === 'google_places' ? 'discovery_only'
      : !profile.qualification.allowedSourceTypes.includes(item.source.type) ? 'source_not_allowed'
      : item.confidence !== 'confirmed' ? 'unconfirmed'
      : age < 0 ? 'observed_in_future'
      : age > profile.qualification.maxEvidenceAgeDays ? 'stale' : null;
    if (reason) factFindings[item.fact].ignored.push({ evidenceIndex: index, reason });
    else factFindings[item.fact].evidenceIndexes.push(index);
  });
  for (const fact of Object.values(factFindings)) {
    const values = [...new Set(fact.evidenceIndexes.map(index => evidence[index].value))];
    if (values.length === 1) { fact.state = 'known'; fact.value = values[0]; }
    else if (values.length > 1) fact.state = 'conflicting';
  }
  const evaluateRule = rule => ({
    id: rule.id, label: rule.label, ...evaluate(rule.when, profile, factFindings),
    unresolvedFacts: expressionFacts(rule.when).filter(id => factFindings[id].state !== 'known'),
  });
  const criteria = profile.qualification.required.map(evaluateRule);
  const exclusions = profile.exclusions.map(rule => ({ ...evaluateRule(rule), effect: rule.effect, onUnknown: rule.onUnknown }));
  const allMandatory = criteria.every(rule => rule.state === true);
  const status = exclusions.some(rule => rule.state === true && rule.effect === 'exclude') ? 'excluded'
    : criteria.some(rule => rule.state === false) ? 'not_qualified'
    : !allMandatory || exclusions.some(rule => (rule.state === true && rule.effect === 'flag') || (rule.state === null && rule.onUnknown === 'review')) ? 'needs_review'
    : 'qualified';
  const signals = profile.signals.map(signal => {
    const result = evaluateRule(signal);
    const datedEvidenceIndexes = signal.event && result.state === true ? result.evidenceIndexes.filter(index => {
      const item = evidence[index];
      if (item.fact !== signal.event.fact || !item.eventDate) return false;
      const delta = (dateNumber(item.eventDate) - today) / DAY;
      return delta >= -signal.event.maxPastDays && delta <= signal.event.maxFutureDays;
    }) : [];
    return { ...result, priority: signal.priority, dated: datedEvidenceIndexes.length > 0, datedEvidenceIndexes };
  }).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const rule = profile.grading.rules.find(rule => (!rule.requireAllMandatory || allMandatory)
    && signals.filter(signal => rule.signalIds.includes(signal.id) && signal.state === true && (!rule.datedOnly || signal.dated)).length >= rule.minMatches);
  const rejected = ['excluded', 'not_qualified'].includes(status);
  const grade = rejected ? null : rule?.grade ?? profile.grading.fallback;
  const matchedSignals = signals.filter(signal => signal.state === true);
  const bestHook = [...matchedSignals].sort((a, b) => Number(b.dated) - Number(a.dated) || a.priority - b.priority)[0];
  return {
    leadId: lead.id, profile: profileIdentity(profile), asOf, status, grade,
    gradeReason: rejected ? 'Kein ICP-Fit: Ausschluss oder verletztes Pflichtkriterium.' : rule?.description ?? profile.grading.fallbackDescription,
    eligibleForEnrichment: status === 'qualified' && profile.enrichment.eligibleGrades.includes(grade),
    criteria, exclusions, signals, factFindings,
    bestHook: !rejected && bestHook ? { signalId: bestHook.id, dated: bestHook.dated, evidenceIndexes: bestHook.dated ? bestHook.datedEvidenceIndexes : bestHook.evidenceIndexes } : null,
    evidence,
  };
}
