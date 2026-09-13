import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardConfig, dashboardRequestAllowed, authorizedAccount, safeReturnPath } from '../lib/runtime.mjs';
import { createLoginLimiter } from '../lib/login-limit.mjs';
import { quizCount, quizEvidence } from '../lib/quiz.mjs';

const env = { DASHBOARD_MODE: 'production', DASHBOARD_ORIGIN: 'https://sales.example.invalid', APPWRITE_ENDPOINT: 'http://appwrite/v1', APPWRITE_PROJECT_ID: 'lead-research', DASHBOARD_ALLOWED_USER_IDS: 'operator-one, operator-two', APPWRITE_SSR_KEY_FILE: '/run/secrets/ssr', SALES_API_TOKEN_FILE: '/run/secrets/api', SALES_API_URL: 'http://sales-api:8787' };
test('Produktionskonfiguration sperrt bei fehlenden Werten und unsicherer öffentlicher Origin', () => {
  assert.equal(dashboardConfig(env).cookieName, '__Host-sales-session');
  for (const key of Object.keys(env)) assert.throws(() => dashboardConfig({ ...env, [key]: '' }), /eingerichtet/);
  for (const origin of ['http://sales.example.invalid', 'https://sales.example.invalid/path', 'https://name:secret@sales.example.invalid', 'https://sales.example.invalid/?key=secret']) assert.throws(() => dashboardConfig({ ...env, DASHBOARD_ORIGIN: origin }));
  assert.equal(dashboardConfig({ DASHBOARD_MODE: 'local' }).apiUrl, 'http://127.0.0.1:8787');
  assert.throws(() => dashboardConfig({}));
});
test('Produktionszugriff prüft Host, Origin, Weiterleitungsheader und CSRF unabhängig von Cookies', () => {
  const config = dashboardConfig(env);
  const headers = values => new Headers({ host: 'sales.example.invalid', ...values });
  assert.equal(dashboardRequestAllowed(headers({}), config), true);
  assert.equal(dashboardRequestAllowed(headers({ origin: env.DASHBOARD_ORIGIN, 'sec-fetch-site': 'same-origin', 'x-forwarded-proto': 'https' }), config, true), true);
  assert.equal(dashboardRequestAllowed(headers({}), config, true), false);
  assert.equal(dashboardRequestAllowed(headers({ origin: 'null', 'sec-fetch-site': 'same-origin' }), config, true), false);
  for (const attack of [{ host: 'attacker.invalid' }, { origin: 'https://attacker.invalid' }, { 'x-forwarded-host': 'attacker.invalid' }, { 'x-forwarded-proto': 'http' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal(dashboardRequestAllowed(headers(attack), config), false);
});
test('Nur aktive Appwrite-Konten mit expliziter Nutzerkennung erhalten Zugriff', () => {
  const ids = dashboardConfig(env).allowedUserIds;
  assert.equal(authorizedAccount({ $id: 'operator-one', status: true }, ids), true);
  for (const account of [null, {}, { $id: 'operator-one', status: false }, { $id: 'outsider', status: true }, { $id: 'outsider', email: 'operator-one', status: true }]) assert.equal(authorizedAccount(account, ids), false);
  assert.equal(safeReturnPath('/leads/firm-1?q=abc'), '/leads/firm-1?q=abc');
  for (const path of ['https://evil.invalid', '//evil.invalid', '/\\evil.invalid', '/api/activities', '/days\r\nlocation:evil', ['//evil.invalid']]) assert.equal(safeReturnPath(path), '/days');
});
test('Anmeldebegrenzung zählt normalisierte Konten und begrenzt wechselnde Konten global', () => {
  const allow = createLoginLimiter();
  for (let n = 0; n < 10; n++) assert.equal(allow(' Operator@Example.invalid ', 1000000), true);
  assert.equal(allow('operator@example.invalid', 1000000), false);
  assert.equal(allow('operator@example.invalid', 1000000 + 900000), true);
  const global = createLoginLimiter();
  for (let n = 0; n < 60; n++) assert.equal(global(`account-${n}@example.invalid`, 1000000), true);
  assert.equal(global('new@example.invalid', 1000001), false);
  assert.equal(global('new@example.invalid', 1060000), true);
});
const event = () => ({ type: 'quiz_completed', details: { source: 'sales-website', website_quiz: {
  event_id: '00000000-0000-4000-8000-000000000001', source_submission_id: '00000000-0000-4000-8000-000000000002', is_test: false,
  contact: { first_name: 'Separate', last_name: 'Person', email: 'form@example.invalid', company: 'Formularfirma', phone: null, provenance: 'quiz_form', captured_at: '2026-09-12T10:00:00Z', source_submission_id: '00000000-0000-4000-8000-000000000002' },
  result: { quiz_id: 'sales-roadmap', quiz_version: 'v4-2026-09-09', stage: 0 },
} } });
test('Quizdarstellung akzeptiert Stufe null und hält Formularherkunft und Testkennzeichnung getrennt', () => {
  const row = event(), before = structuredClone(row);
  assert.equal(quizEvidence(row).result.stage, 0);
  assert.equal(quizEvidence(row).contact.email, 'form@example.invalid');
  assert.deepEqual(row, before);
  row.details.website_quiz.is_test = true;
  assert.equal(quizEvidence(row).is_test, true);
  assert.equal(quizEvidence({ event_type: row.type, details_json: JSON.stringify(row.details) }).is_test, true);
  for (const change of [q => delete q.is_test, q => q.source_submission_id = 'unknown', q => q.contact.source_submission_id = 'other', q => q.contact.provenance = 'researched', q => q.contact.captured_at = 'invalid', q => q.result.stage = 7, q => q.result.stage = '0', q => q.contact.email = '']) {
    const invalid = event(); change(invalid.details.website_quiz); assert.equal(quizEvidence(invalid), null);
  }
  assert.equal(quizEvidence({ ...row, details_json: '{invalid' }), null);
  for (const raw of ['null', '42', '[]']) assert.equal(quizEvidence({ ...row, details_json: raw }), null);
  assert.equal(quizEvidence({ ...row, type: 'click' }), null);
});
test('Unbekannte Quizhistorie wird auch bei recordedCount null nicht als Null ausgegeben', () => {
  assert.equal(quizCount({ value: 0, unit: 'submissions' }), 0);
  assert.equal(quizCount({ value: 3, unit: 'submissions' }), 3);
  for (const metric of [null, {}, { value: null, recordedCount: 0, unit: 'submissions' }, { value: null, recordedCount: 2, unit: 'submissions' }, { value: 2, unit: 'messages' }, { value: -1, unit: 'submissions' }, { value: 1.5, unit: 'submissions' }]) assert.equal(quizCount(metric), null);
});
