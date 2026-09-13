import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildStorageBundle, profileMarkdown } from '../src/storage.mjs';
import { loadProfile, profileIdentity } from '../src/icp.mjs';
import { qualifyLead } from '../src/qualification.mjs';
import { fictionalStorageResearch } from './fixtures/storage-research.mjs';

const read = async path => readFile(new URL(path, import.meta.url), 'utf8');
const profile = await loadProfile();
const fixture = {
  profile, profileSource: await read('../icp/consulting-dach.yaml'), profilePath: 'icp/consulting-dach.yaml',
  ...fictionalStorageResearch(profile),
  client: { id: 'own', name: 'Eigener Vertrieb' }, campaign: { id: 'consulting-dach', name: 'Consulting DACH' },
  runKey: 'fixture', engineHash: 'a'.repeat(64),
};
const rows = (bundle, table) => bundle.rows.filter(row => row.table === table);

test('Fiktive Recherche behält Quellen, offene Fälle und Ausschlüsse; nur qualifizierte Leads haben Kontakte', () => {
  const bundle = buildStorageBundle(fixture);
  assert.equal(rows(bundle, 'companies').length, 5);
  assert.equal(rows(bundle, 'contacts').length, 2);
  assert.equal(rows(bundle, 'evidence').length, fixture.leads.reduce((sum, lead) => sum + lead.evidence.length, 0));
  assert.deepEqual(rows(bundle, 'assessments').map(r => r.data.status), ['qualified', 'qualified', 'needs_review', 'excluded', 'excluded']);
  assert.equal(rows(bundle, 'outreach_messages').length, 0);
  assert.equal(rows(bundle, 'outreach_events').length, 0);
  for (const contact of rows(bundle, 'contacts')) {
    const enrichment = rows(bundle, 'enrichments').find(e => e.id === contact.data.source_enrichment_id);
    const assessment = rows(bundle, 'assessments').find(a => a.id === enrichment.data.assessment_id);
    assert.equal(assessment.data.eligible_for_enrichment, true);
  }
  assert.match(rows(bundle, 'contacts')[1].data.email_type, /Zentrale/);
});

test('Wiederholung ist deterministisch, neuer Lauf wiederverwendet Firmen und erzeugt neue Bewertungen', () => {
  const first = buildStorageBundle(fixture);
  assert.deepEqual(buildStorageBundle(fixture), first);
  const next = buildStorageBundle({ ...fixture, runKey: 'second-run' });
  assert.deepEqual(rows(first, 'companies'), rows(next, 'companies'));
  assert.notEqual(rows(first, 'assessments')[0].id, rows(next, 'assessments')[0].id);
  assert.equal(rows(first, 'icp_versions')[0].id, rows(next, 'icp_versions')[0].id);
  assert.equal(rows(first, 'contacts')[0].id, rows(next, 'contacts')[0].id);
});

test('Auftraggeber erhalten getrennte Firmenidentitäten und vollständige interne Referenzen', () => {
  const first = buildStorageBundle(fixture);
  const second = buildStorageBundle({ ...fixture, client: { id: 'client-two', name: 'Zweiter Auftraggeber' } });
  assert.notEqual(rows(first, 'companies')[0].id, rows(second, 'companies')[0].id);
  for (const row of second.rows) {
    const table = second.schema.tables.find(t => t.id === row.table);
    for (const [field, target] of Object.entries(table.references)) {
      assert.ok(second.rows.some(r => r.table === target && r.id === row.data[field]), `${row.table}.${field}`);
    }
  }
});

test('Manipulierte Bewertungen, falsche Profilversionen und doppelte Ergebnisse werden abgewiesen', () => {
  const changed = structuredClone(fixture);
  changed.evaluation.results[0].qualification.grade = 'A';
  assert.throws(() => buildStorageBundle(changed), /nicht reproduzierbar/);
  changed.evaluation = structuredClone(fixture.evaluation);
  changed.profile.version = '2.0.0';
  assert.throws(() => buildStorageBundle(changed), /ICP-Version/);
  const duplicate = structuredClone(fixture);
  duplicate.evaluation.results[1] = duplicate.evaluation.results[0];
  assert.throws(() => buildStorageBundle(duplicate), /doppelte oder fehlende/);
});

test('Enrichment-Grenze gilt auch für importierte Ergebnisse', () => {
  const changed = structuredClone(fixture);
  changed.evaluation.results[2].enrichment = { status: 'completed', data: { contact: { name: 'Unzulässig' } } };
  assert.throws(() => buildStorageBundle(changed), /nicht freigegeben/);
});

test('Anderes ICP speichert andere Fakten mit demselben Datenbankschema', async () => {
  const alternate = await loadProfile(new URL('../icp/examples/manufacturing-uk.yaml', import.meta.url));
  const lead = { id: 'fictional-uk', name: 'Fiktiver Testbetrieb', website: 'https://factory.example', evidence: [
    ['headquarters', 'GB'], ['workforce', 120], ['sector', 'manufacturing'],
  ].map(([fact, value]) => ({ fact, value, confidence: 'confirmed', observedAt: '2026-09-10', source: { type: 'website', url: 'https://factory.example/about', quote: 'Fiktiver Testbeleg.' } })) };
  const qualification = qualifyLead({ profile: alternate, lead, evidence: lead.evidence, asOf: '2026-09-10' });
  assert.equal(qualification.grade, 'B');
  assert.equal(qualification.eligibleForEnrichment, false);
  const bundle = buildStorageBundle({ ...fixture, profile: alternate, profileSource: await read('../icp/examples/manufacturing-uk.yaml'), profilePath: 'icp/examples/manufacturing-uk.yaml', leads: [lead],
    evaluation: { profile: profileIdentity(alternate), asOf: '2026-09-10', results: [{ leadId: lead.id, qualification, enrichment: { status: 'skipped' } }] },
  });
  assert.deepEqual(bundle.schema, buildStorageBundle(fixture).schema);
  assert.deepEqual(rows(bundle, 'evidence').map(r => r.data.fact_key), ['headquarters', 'workforce', 'sector']);
  assert.equal(rows(bundle, 'contacts').length, 0);
  assert.doesNotMatch(profileMarkdown(alternate, 'icp/examples/manufacturing-uk.yaml'), /undefined/);
});

test('Historische Version enthält vollständige Definition unabhängig vom Dateipfad', () => {
  const version = rows(buildStorageBundle(fixture), 'icp_versions')[0].data;
  assert.deepEqual(JSON.parse(version.definition_json), profile);
  assert.equal(version.source_yaml, fixture.profileSource);
  assert.match(version.readable_markdown, /Pflichtkriterien/);
  assert.throws(() => buildStorageBundle({ ...fixture, profilePath: '../outside.yaml' }), /relativ/);
});
