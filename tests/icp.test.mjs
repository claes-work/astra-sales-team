import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildDiscoveryRequest, loadProfile, profileIdentity, validateProfile } from '../src/icp.mjs';
import { qualifyLead } from '../src/qualification.mjs';
import { buildEvidenceDossier, runPipeline } from '../src/pipeline.mjs';
import { discoverWithPlaces } from '../src/discovery.mjs';

const profile = await loadProfile();
const alternative = await loadProfile(new URL('../icp/examples/manufacturing-uk.yaml', import.meta.url));
const example = JSON.parse(await readFile(new URL('../examples/consulting-evidence.json', import.meta.url), 'utf8'));
const asOf = '2026-09-10';
const lead = { id: 'test-lead' };
const baseline = example.leads[0].evidence.filter(item => item.fact !== 'aiHiring');
const observation = (fact, value, extra = {}) => ({ fact, value, confidence: 'confirmed', observedAt: asOf, source: { type: 'website', url: 'https://evidence.example/source', quote: 'Explizit fiktiver Testbeleg.' }, ...extra });
const withValues = values => baseline.map(item => Object.hasOwn(values, item.fact) ? { ...item, value: values[item.fact] } : item);
const qualify = (evidence = baseline, selectedProfile = profile) => qualifyLead({ profile: selectedProfile, lead, evidence, asOf });

test('Consulting-Profil und alternatives Profil erfüllen Schema und Referenzen', () => {
  assert.equal(validateProfile(profile), profile);
  assert.equal(validateProfile(alternative), alternative);
  assert.equal(profile.signals.length, 7);
  assert.equal(profileIdentity(profile).sha256.length, 64);
  const changed = structuredClone(profile);
  changed.target.companySize.max = 30;
  assert.notEqual(profileIdentity(changed).sha256, profileIdentity(profile).sha256);
});

test('Profilfehler scheitern früh: unbekannte Felder, IDs, Typen, Operatoren, Referenzen und Bewertungen', () => {
  const changes = [
    p => { p.typo = true; },
    p => { p.schemaVersion = 2; },
    p => { p.qualification.required[0].when.fact = 'missing'; },
    p => { p.qualification.required[0].when.valueFrom = 'target.missing'; },
    p => { p.qualification.required[0].when.op = 'execute'; },
    p => { p.qualification.required[1].when.all[0].valueFrom = 'target.audience'; },
    p => { p.signals[0].id = 'S2'; },
    p => { p.signals[0].event.fact = 'country'; },
    p => { p.grading.rules[0].signalIds = ['missing']; },
    p => { p.grading.rules[0].minMatches = 99; },
    p => { p.grading.rules[0].signalIds = ['S2']; },
    p => { p.grading.rules[0].minMatches = 0; },
    p => { p.qualification.allowedSourceTypes.push('google_places'); },
    p => { p.target.companySize.min = 100; },
    p => { p.discovery.queries = ['{unsupported}']; },
    p => { p.facts.ownerLed.values = ['yes']; },
  ];
  for (const change of changes) {
    const copy = structuredClone(profile);
    change(copy);
    assert.throws(() => validateProfile(copy), /Ungültiges ICP-Profil/);
  }
});

test('Loader lehnt doppelte YAML-Schlüssel und Aliase ab', async () => {
  const path = join(tmpdir(), `icp-test-${randomUUID()}.yaml`);
  try {
    await writeFile(path, 'id: one\nid: two\n');
    await assert.rejects(loadProfile(path), /ICP-YAML/);
    await writeFile(path, 'a: &alias [1, 2]\nb: *alias\n');
    await assert.rejects(loadProfile(path), /ICP-YAML/);
  } finally { await unlink(path); }
});

test('Profilwechsel steuert Discovery: DACH, UK, Sprache und ausgewählte Suche', () => {
  assert.deepEqual(buildDiscoveryRequest(profile, { country: 'at' }), { textQuery: 'Unternehmensberatung in Wien, Österreich', languageCode: 'de', regionCode: 'AT' });
  assert.match(buildDiscoveryRequest(profile, { country: 'CH', queryIndex: 1 }).textQuery, /IT- und Digitalisierungsberatung in Zürich, Schweiz/);
  assert.deepEqual(buildDiscoveryRequest(alternative), { textQuery: 'Industrial manufacturers in Birmingham, United Kingdom', languageCode: 'en', regionCode: 'GB' });
  assert.throws(() => buildDiscoveryRequest(profile, { country: 'GB' }), /Land/);
  assert.throws(() => buildDiscoveryRequest(profile, { queryIndex: 99 }), /Suchindex/);
});

test('Profilwechsel steuert neue Fakt-IDs, Größen, Signale, Fristen und Enrichment-Regeln', () => {
  const facts = [observation('headquarters', 'GB'), observation('workforce', 120), observation('sector', 'manufacturing')];
  const b = qualify(facts, alternative);
  assert.equal(b.status, 'qualified');
  assert.equal(b.grade, 'B');
  assert.equal(b.eligibleForEnrichment, false);
  const a = qualify([...facts, observation('modernization', true, { eventDate: '2026-06-01' })], alternative);
  assert.equal(a.grade, 'A');
  assert.equal(a.eligibleForEnrichment, true);
  assert.equal(a.bestHook.signalId, 'investment');
});

test('A benötigt bestätigten aktuellen datierten Trigger, B nur belegten Fit, fehlende Evidenz ergibt C', () => {
  const a = qualify(example.leads[0].evidence);
  assert.equal(a.grade, 'A');
  assert.equal(a.status, 'qualified');
  assert.equal(a.bestHook.signalId, 'S1');
  assert.equal(qualify().grade, 'B');
  assert.equal(qualify().eligibleForEnrichment, true);
  assert.equal(qualify([]).grade, 'C');
  assert.equal(qualify([]).status, 'needs_review');
  assert.equal(qualify([]).eligibleForEnrichment, false);
});

test('Teamgröße behandelt Grenzen und Ausschluss getrennt, DACH ist kein Places-Länderfilter', () => {
  for (const [size, status] of [[4, 'excluded'], [5, 'not_qualified'], [7, 'not_qualified'], [8, 'qualified'], [25, 'qualified'], [26, 'not_qualified']]) {
    const result = qualify(withValues({ employeeCount: size }));
    assert.equal(result.status, status);
    assert.equal(result.eligibleForEnrichment, status === 'qualified');
  }
  for (const country of ['DE', 'AT', 'CH']) assert.equal(qualify(withValues({ country })).status, 'qualified');
  assert.equal(qualify(withValues({ country: 'FR' })).status, 'not_qualified');
});

test('Unbekannt bleibt unbekannt: NOT, fehlende Website, KI-Lücke und Firmenidentität', () => {
  const empty = qualify([]);
  assert.equal(empty.exclusions.find(r => r.id === 'wrong_industry').state, null);
  assert.equal(empty.signals.find(r => r.id === 'S2').state, null);
  for (const fact of ['aiPracticeMaturity', 'websiteExists', 'identityConfirmed', 'active']) {
    const result = qualify(baseline.filter(item => item.fact !== fact));
    assert.equal(result.status, 'needs_review');
    assert.equal(result.eligibleForEnrichment, false);
  }
});

test('Places-Evidenz, Inferenz, veraltete und zukünftige Beobachtungen beweisen keinen Fit', () => {
  for (const [patch, reason] of [
    [{ source: { type: 'google_places', url: 'https://maps.example/place', quote: 'Discovery-Kategorie' } }, 'discovery_only'],
    [{ confidence: 'inferred' }, 'unconfirmed'],
    [{ observedAt: '2025-01-01' }, 'stale'],
    [{ observedAt: '2026-09-11' }, 'observed_in_future'],
  ]) {
    const result = qualify(baseline.map(item => item.fact === 'ownerLed' ? { ...item, ...patch } : item));
    assert.equal(result.status, 'needs_review');
    assert.equal(result.factFindings.ownerLed.state, 'unknown');
    assert.equal(result.factFindings.ownerLed.ignored[0].reason, reason);
  }
  const narrow = structuredClone(profile);
  narrow.qualification.allowedSourceTypes = ['registry'];
  assert.equal(qualify(baseline, narrow).factFindings.ownerLed.ignored[0].reason, 'source_not_allowed');
});

test('Widersprüchliche bestätigte Fakten blockieren Qualifizierung', () => {
  const result = qualify([...baseline, observation('ownerLed', false)]);
  assert.equal(result.factFindings.ownerLed.state, 'conflicting');
  assert.equal(result.status, 'needs_review');
  assert.equal(result.eligibleForEnrichment, false);
});

test('Abrufdatum, undatierte oder alte Stellenanzeigen erzeugen kein A; Datumsgrenzen sind inklusiv', () => {
  for (const [eventDate, grade] of [[undefined, 'B'], ['2026-06-11', 'B'], ['2026-06-12', 'A'], ['2026-09-10', 'A'], ['2026-09-11', 'B']]) {
    const extra = eventDate ? { eventDate } : {};
    assert.equal(qualify([...baseline, observation('aiHiring', true, extra)]).grade, grade);
  }
  const result = qualify([...baseline, observation('aiHiring', true, { eventDate: '2026-09-01', confidence: 'inferred' })]);
  assert.equal(result.grade, 'B');
});

test('Datierte Events schlagen undatierte höher priorisierte Hooks; Priorität bleibt konfigurierbar', () => {
  const evidence = [...baseline, observation('aiHiring', true), observation('talkEvent', true, { eventDate: '2026-09-24' })];
  const result = qualify(evidence);
  assert.equal(result.grade, 'A');
  assert.equal(result.bestHook.signalId, 'S4');
  assert.equal(result.evidence[result.bestHook.evidenceIndexes[0]].eventDate, '2026-09-24');
  const modified = structuredClone(profile);
  modified.signals.find(s => s.id === 'S4').priority = 1;
  modified.signals.find(s => s.id === 'S1').priority = 9;
  assert.equal(qualify([...evidence, observation('aiHiring', true, { eventDate: '2026-09-01' })], modified).bestHook.signalId, 'S4');
});

test('Ein Datum auf einem unbeteiligten Fakt reicht nicht für ein datiertes Signal', () => {
  const evidence = [...baseline.map(item => item.fact === 'country' ? { ...item, eventDate: '2026-09-01' } : item), observation('aiHiring', true)];
  assert.equal(qualify(evidence).grade, 'B');
  const modified = structuredClone(profile);
  modified.signals[0].when = { any: [{ fact: 'aiHiring', op: 'eq', value: true }, { fact: 'growth', op: 'eq', value: true }] };
  const result = qualify([...baseline, observation('aiHiring', false, { eventDate: '2026-09-01' }), observation('growth', true)], modified);
  assert.equal(result.signals.find(s => s.id === 'S1').state, true);
  assert.equal(result.signals.find(s => s.id === 'S1').dated, false);
  assert.equal(result.grade, 'B');
});

test('Recruiting/Agentur bleibt markiert; starke KI-Praxis wird trotz Hiring ausgeschlossen', () => {
  for (const industry of ['recruiting', 'agency']) {
    const result = qualify(withValues({ industry }));
    assert.equal(result.status, 'excluded');
    assert.equal(result.grade, null);
    assert.equal(result.exclusions.find(r => r.id === 'misclassified').state, true);
  }
  const established = qualify([...withValues({ aiPracticeMaturity: 'established' }), observation('aiHiring', true, { eventDate: '2026-09-01' })]);
  assert.equal(established.status, 'excluded');
  assert.equal(established.eligibleForEnrichment, false);
  assert.equal(qualify(example.leads[0].evidence).status, 'qualified');
  for (const fact of ['websiteExists', 'identityConfirmed', 'active']) assert.equal(qualify(withValues({ [fact]: false })).status, 'excluded');
});

test('A/B/C-Logik und Freigaben werden vollständig aus dem Profil gelesen', () => {
  const modified = structuredClone(profile);
  modified.grading.rules[1].signalIds = ['S6'];
  modified.grading.rules[1].minMatches = 1;
  const result = qualify(baseline, modified);
  assert.equal(result.grade, 'C');
  assert.equal(result.status, 'qualified');
  assert.equal(result.eligibleForEnrichment, false);
  assert.equal(qualify([...baseline, observation('budgetTiming', true)], modified).grade, 'B');
  modified.enrichment.eligibleGrades = ['A', 'B', 'C'];
  assert.equal(qualify(baseline, modified).eligibleForEnrichment, true);
});

test('Belegfehler stoppen: Quelle, Kalenderdatum, Datentyp, Enum und unbekannte Fakten', () => {
  for (const patch of [
    { fact: 'missing' }, { value: '15' }, { observedAt: '2026-02-30' },
    { eventDate: '2026-09-10T12:00:00Z' }, { confidence: 'maybe' },
    { source: { type: 'website', url: 'javascript:alert(1)', quote: 'Beleg' } },
    { source: { type: 'website', url: 'https://evidence.example', quote: '' } },
    { source: { type: 'website', url: 'https://user:password@evidence.example', quote: 'Beleg' } },
  ]) assert.throws(() => qualify([observation('employeeCount', 15, patch)]), /Beleg/);
  assert.throws(() => qualify([observation('aiPracticeMaturity', 'unbekannt')]), /Beleg/);
  assert.throws(() => qualifyLead({ profile, lead, asOf: '2026-02-30' }), /asOf/);
});

test('Pipeline-Reihenfolge und Gate: nur qualifizierte A/B-Leads werden angereichert', async () => {
  const events = [];
  const candidates = [
    { id: 'a', evidence: example.leads[0].evidence },
    { id: 'b', evidence: baseline },
    { id: 'c', evidence: [] },
    { id: 'excluded', evidence: withValues({ industry: 'agency' }) },
    { id: 'outside', evidence: withValues({ employeeCount: 26 }) },
    { id: 'unclear', evidence: baseline.filter(e => e.fact !== 'aiPracticeMaturity') },
  ];
  const results = await runPipeline({
    profile, asOf,
    discover: async () => { events.push('discover'); return candidates; },
    collectEvidence: async ({ candidate, researchPlan }) => { events.push(`qualify:${candidate.id}`); assert.ok(researchPlan.length > 0); return candidate.evidence; },
    enrich: async context => { events.push(`enrich:${context.candidate.id}`); return buildEvidenceDossier(context); },
  });
  assert.deepEqual(events, ['discover', 'qualify:a', 'enrich:a', 'qualify:b', 'enrich:b', 'qualify:c', 'qualify:excluded', 'qualify:outside', 'qualify:unclear']);
  assert.deepEqual(results.map(r => r.enrichment.status), ['completed', 'completed', 'skipped', 'skipped', 'skipped', 'skipped']);
  assert.equal(results[0].enrichment.data.newExternalResearch, false);
});

test('Fehlender Enrichment-Adapter bleibt pending, Fehler sperren Enrichment und stoppen andere Leads nicht', async () => {
  const discover = async () => [{ id: 'one' }, { id: 'two' }];
  const pending = await runPipeline({ profile, asOf, discover, collectEvidence: async () => baseline });
  assert.equal(pending[0].enrichment.status, 'pending');
  const results = await runPipeline({ profile, asOf, discover,
    collectEvidence: async ({ candidate }) => { if (candidate.id === 'one') throw new Error('SECRET'); return baseline; },
    enrich: async () => { throw new Error('SECRET'); },
  });
  assert.equal(results[0].enrichment.reason, 'qualification_failed');
  assert.equal(results[1].enrichment.status, 'failed');
  assert.ok(!JSON.stringify(results).includes('SECRET'));
});

test('Reine Places-Metadaten ergeben niemals ICP-Fit; keine Website-Angabe wird nicht false', async () => {
  let calls = 0;
  const results = await runPipeline({ profile, asOf,
    discover: () => discoverWithPlaces({ profile, key: 'FAKE', fetchImpl: async () => {
      calls++;
      return Response.json({ places: [{ id: 'place-id', displayName: { text: 'Consulting' }, formattedAddress: 'Berlin', ownerLed: true, employeeCount: 15 }] });
    }}),
    enrich: () => assert.fail('Enrichment darf nicht laufen'),
  });
  assert.equal(calls, 1);
  assert.equal(results[0].qualification.status, 'needs_review');
  assert.equal(results[0].qualification.factFindings.websiteExists.state, 'unknown');
  assert.ok(!JSON.stringify(results).includes('formattedAddress'));
});

test('CLI-Demo läuft offline mit Profilstempel; ungültige Optionen scheitern ohne API-Schlüssel', () => {
  const env = { ...process.env };
  delete env.ICP_PROFILE;
  delete env.GOOGLE_PLACES_API_KEY;
  const script = new URL('../src/leads.mjs', import.meta.url);
  const run = args => spawnSync(process.execPath, [fileURLToPath(script), ...args], { env, encoding: 'utf8' });
  const result = run(['research', '--input', 'examples/consulting-evidence.json', '--as-of', asOf]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.profile.id, profile.id);
  assert.deepEqual(report.results.map(r => r.enrichment.status), ['completed', 'skipped', 'skipped']);
  assert.notEqual(run(['qualify', '--input', 'examples/consulting-evidence.json', '--as-of', 'invalid']).status, 0);
  assert.notEqual(run(['check', '--city', 'Berlin']).status, 0);
});
