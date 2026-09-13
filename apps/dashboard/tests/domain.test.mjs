import { test } from 'node:test';
import assert from 'node:assert/strict';
import { berlinInstant, count, date, localMinute, safeWebsite, sentTime, proxyNote, duration } from '../lib/format.mjs';
import { activityInput, leadQuery, localRequestAllowed } from '../lib/input.mjs';

test('Berlin-Zeit wird im Sommer und Winter korrekt gespeichert, ohne Browser-Zeitzone', () => {
  assert.equal(berlinInstant('2026-09-10T12:30'), '2026-09-10T10:30:00.000Z');
  assert.equal(berlinInstant('2026-01-10T12:30'), '2026-01-10T11:30:00.000Z');
  assert.equal(localMinute(new Date('2026-09-10T22:15:00Z')), '2026-09-11T00:15');
});
test('Nicht vorhandene und doppelte Ortszeiten werden nicht still umgedeutet', () => {
  assert.throws(() => berlinInstant('2026-03-29T02:30'), /gibt es.*nicht/);
  assert.throws(() => berlinInstant('2026-10-25T02:30'), /zweimal/);
  assert.equal(berlinInstant('2026-10-25T02:30', '+02:00'), '2026-10-25T00:30:00.000Z');
  assert.equal(berlinInstant('2026-10-25T02:30', '+01:00'), '2026-10-25T01:30:00.000Z');
  assert.throws(() => berlinInstant('2026-02-30T13:00'), /gibt es/);
  assert.throws(() => berlinInstant('2026-09-10T12:30', '+01:00'), /Zeitversatz/);
});
test('Unbekannte Zähler und Zeiten werden nicht zu Null; Zustellzeit bleibt als Ersatz markiert', () => {
  assert.equal(count(null), '—'); assert.equal(count(undefined), '—'); assert.equal(count(0), '0');
  assert.equal(date(null), 'Unbekannt');
  assert.match(sentTime({ sentAt: '2026-09-10T22:15:00Z', sentAtIsProxy: true }), /11\.09\.2026.*Zustellzeit; Versandzeit unbekannt/);
  assert.match(proxyNote({ sentTimeProxyMessages: 2 }), /2 davon dem Zustelltag/);
  assert.equal(sentTime({}), 'Versandzeit nicht belegt');
});
test('Such-/Filterparameter bleiben begrenzt, sortiert und frei von unbekannten Optionen', () => {
  const query = leadQuery({ page: '-5', pageSize: '999', q: '  DEMO  ', sort: 'arbitrary', fit: 'qualified', outreach: 'sent', blocked: 'false', positive: 'true', execute: 'true' });
  assert.equal(query.page, '1'); assert.equal(query.pageSize, '100'); assert.equal(query.q, 'DEMO');
  assert.equal(query.sort, 'name_asc'); assert.equal(query.fit, 'qualified'); assert.equal(query.outreach, 'sent');
  assert.equal(query.blocked, 'false'); assert.equal(query.positive, 'true'); assert.ok(!('execute' in query));
});
const raw = { companyId: 'test-company', type: 'conversation_positive', channel: 'phone', localTime: '2026-09-10T12:30', offset: 'auto', sourceId: '00000000-0000-4000-8000-000000000003', note: ' Hat Interesse am Gespräch. ', by: ' Testperson ' };
test('Rückmeldung hat eine stabile Kennung, Berlin-Zeit und feste Auditquelle', () => {
  const value = activityInput(raw, Date.parse('2026-09-11T00:00:00Z'));
  assert.equal(value.sourceId, raw.sourceId); assert.equal(value.occurredAt, '2026-09-10T10:30:00.000Z');
  assert.equal(value.source, 'sales-dashboard'); assert.equal(value.note, 'Hat Interesse am Gespräch.'); assert.equal(value.by, 'Testperson');
  assert.equal(value.type, 'conversation_positive'); assert.ok(!('messageId' in value));
  assert.deepEqual(value, activityInput(raw, Date.parse('2026-09-11T00:00:00Z')));
});
test('Manuelle Eingaben können keine Providerereignisse, Freigaben oder Entsperrungen erzeugen', () => {
  for (const type of ['provider_sent', 'delivered', 'reply_positive', 'meeting_qualified', 'unblock', 'approve']) assert.throws(() => activityInput({ ...raw, type }), /gültige Rückmeldung/);
  assert.throws(() => activityInput({ ...raw, execute: true }), /Unbekannte Eingabefelder/);
  assert.throws(() => activityInput({ ...raw, source: 'brevo' }), /Unbekannte Eingabefelder/);
  assert.throws(() => activityInput({ ...raw, note: ' ' }), /Notiz/);
  assert.throws(() => activityInput({ ...raw, by: ' ' }), /Namen/);
  assert.throws(() => activityInput({ ...raw, localTime: '2026-09-12T12:30' }, Date.parse('2026-09-11T00:00:00Z')), /Zukunft/);
});
test('Lokaler Zugriff verwirft DNS-Rebinding, fremde Ursprünge und ungedeckte Schreibanfragen', () => {
  const headers = values => new Headers(values);
  assert.equal(localRequestAllowed(headers({ host: '127.0.0.1:3000' })), true);
  assert.equal(localRequestAllowed(headers({ host: 'localhost:3000', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }), '3000', true), true);
  assert.equal(localRequestAllowed(headers({ host: 'attacker.example:3000' })), false);
  assert.equal(localRequestAllowed(headers({ host: '127.0.0.1:3000', origin: 'https://attacker.example' })), false);
  assert.equal(localRequestAllowed(headers({ host: '127.0.0.1:3000' }), '3000', true), false);
  assert.equal(localRequestAllowed(headers({ host: '127.0.0.1:3000', 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(localRequestAllowed(headers({ host: '127.0.0.1:3000', 'x-forwarded-host': 'attacker.example' })), false);
});
test('Website-Links lassen keine ausführbaren Protokolle zu', () => {
  assert.equal(safeWebsite('javascript:alert(1)'), null); assert.equal(safeWebsite('file:///secret'), null);
  assert.equal(safeWebsite('https://example.invalid'), 'https://example.invalid/');
});
test('Gemessene kurze Regelprüfungen runden nicht auf null Minuten; fehlende Dauer bleibt unbekannt', () => {
  assert.equal(duration(751), '751 ms'); assert.equal(duration(1520), '1,5 Sek.');
  assert.equal(duration(90000), '1,5 Min.'); assert.equal(duration(0, false), 'Noch nicht erfasst');
  assert.equal(duration(null), 'Noch nicht erfasst');
});
