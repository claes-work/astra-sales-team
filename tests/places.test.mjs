import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { searchPlaces } from '../src/places.mjs';
import { buildDiscoveryRequest, loadProfile } from '../src/icp.mjs';

const key = 'FAKE_OFFLINE_KEY';
const profile = await loadProfile();
const request = buildDiscoveryRequest(profile);
test('Smoke: genau ein POST, ID-Maske, ein Treffer, kein Paging/Redirect', async () => {
  let calls = 0;
  const places = await searchPlaces({ key, request, smoke: true, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://places.googleapis.com/v1/places:searchText');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Goog-Api-Key'], key);
    assert.equal(options.headers['X-Goog-FieldMask'], 'places.id');
    assert.equal(JSON.parse(options.body).pageSize, 1);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ places: [{ id: 'one' }], nextPageToken: 'ignored' });
  }});
  assert.equal(calls, 1);
  assert.equal(places.length, 1);
});

test('Suche: maximal fünf Treffer und Websites nur explizit', async () => {
  for (const websites of [false, true]) {
    const result = await searchPlaces({ key, request: buildDiscoveryRequest(profile, { city: 'München' }), websites, fetchImpl: async (_, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.textQuery, 'Unternehmensberatung in München, Deutschland');
      assert.equal(body.pageSize, 5);
      assert.equal(body.regionCode, 'DE');
      assert.equal(options.headers['X-Goog-FieldMask'].includes('places.websiteUri'), websites);
      assert.ok(options.headers['X-Goog-FieldMask'].includes('places.attributions'));
      return Response.json({ places: Array.from({ length: 6 }, () => ({ id: 'fake' })) });
    }});
    assert.equal(result.length, 5);
  }
});

test('Fehlende Eingaben stoppen vor Netzwerk', async () => {
  const fetchImpl = () => assert.fail('Netzwerk darf nicht aufgerufen werden');
  await assert.rejects(searchPlaces({ key: '', request, fetchImpl }), /API-Schlüssel/);
  await assert.rejects(searchPlaces({ key, request: { ...request, textQuery: '' }, fetchImpl }), /Discovery-Anfrage/);
  await assert.rejects(searchPlaces({ key, fetchImpl }), /Discovery-Anfrage/);
  assert.throws(() => buildDiscoveryRequest(profile, { city: '' }), /Stadt/);
});

test('HTTP-Fehler geben keine fremden Inhalte oder Secrets aus; kein Retry', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(searchPlaces({ key, request, fetchImpl: async () => {
      calls++;
      return new Response(key, { status });
    }}), error => error.message.includes(String(status)) && !error.message.includes(key));
    assert.equal(calls, 1);
  }
});

test('Netzwerkfehler werden bereinigt', async () => {
  await assert.rejects(searchPlaces({ key, request, fetchImpl: async () => { throw new Error(key); } }), error => !error.message.includes(key) && error.message.includes('Zeitlimit'));
});

test('Leere und defekte Antworten', async () => {
  assert.deepEqual(await searchPlaces({ key, request, fetchImpl: async () => Response.json({}) }), []);
  await assert.rejects(searchPlaces({ key, request, fetchImpl: async () => new Response('invalid') }), /unlesbare/);
  await assert.rejects(searchPlaces({ key, request, fetchImpl: async () => Response.json({ places: 'invalid' }) }), /unlesbare/);
  await assert.rejects(searchPlaces({ key, request, fetchImpl: async () => Response.json({ places: [{}] }) }), /unlesbare/);
});

test('CLI-Konfiguration isoliert: fehlt, Datei, Umgebungs-Vorrang, keine Secret-Ausgabe', () => {
  // Niemals die echte lokale Secret-Datei oder deren Inhalt für Tests verwenden.
  const root = mkdtempSync(join(tmpdir(), 'sales-places-test-'));
  const src = join(root, 'src');
  // copy destination parent via recursive mkdir, keeping cleanup inside this unique temp directory.
  return import('node:fs').then(({ mkdirSync }) => {
    mkdirSync(src);
    const script = join(src, 'places.mjs');
    copyFileSync(new URL('../src/places.mjs', import.meta.url), script);
    const env = { ...process.env };
    delete env.GOOGLE_PLACES_API_KEY;
    const run = () => spawnSync(process.execPath, [script, 'check'], { env, encoding: 'utf8' });
    try {
      assert.match(run().stderr, /GOOGLE_PLACES_API_KEY fehlt/);
      writeFileSync(join(root, '.env.local'), `GOOGLE_PLACES_API_KEY=${key}\n`);
      const result = run();
      assert.equal(result.status, 0);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(key));
      writeFileSync(join(root, '.env.local'), 'GOOGLE_PLACES_API_KEY="invalid key"\n');
      env.GOOGLE_PLACES_API_KEY = key;
      assert.equal(run().status, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
