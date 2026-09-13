import test from 'node:test';
import assert from 'node:assert/strict';
import { contentFixture } from './helpers/outreach-content.mjs';
import { contentHash, reviewContentHash, validateProfile, loadContentFile } from '../src/outreach/profiles.mjs';
import { validateExperiment } from '../src/outreach/experiment.mjs';
import { createApi } from '../src/outreach/http.mjs';
import { parse } from 'yaml';

test('draft edits require current hash, immutable versions reject reuse, export round-trips', async () => {
  const f = await contentFixture(); const current = (await f.service.listContent({ clientId: 'own', kind: 'strategy' }))[0];
  const changed = { ...current.definition, tone: 'Neue Tonalität' };
  await assert.rejects(() => f.service.editDraft({ draftId: current.id, expectedHash: 'stale', definition: changed }), /inzwischen/);
  const draft = await f.service.editDraft({ draftId: current.id, expectedHash: current.contentHash, definition: changed });
  await assert.rejects(() => f.service.publishDraft({ draftId: draft.id, expectedHash: draft.contentHash }), /Versionsnummer/);
  changed.version = '2'; const next = await f.publish('strategy', changed);
  assert.equal(next.version, '2');
  assert.deepEqual(parse((await f.service.exportContent({ id: next.id, version: true })).yaml), changed);
  const first = await f.service.resolveVersion('own', 'strategy', f.strategy);
  assert.equal(first.definition.tone, f.strategy.tone);
});

test('individual bodies vary by firm, A/B changes only subject, preview and historical approval remain frozen', async () => {
  const f = await contentFixture(); const one = await f.enroll(); const two = await f.enroll(1);
  assert.notEqual(one.preview.body, two.preview.body);
  assert.equal(one.preview.candidates[0].body, one.preview.candidates[1].body);
  assert.equal(one.preview.personalization.dependencies.evidence[0].sourceQuote, 'Fiktives Beispiel zur Softwareprüfung.');
  assert.equal(one.preview.semanticsAutomaticallyVerified, false);
  const id = await f.send();
  const p = structuredClone(f.personalizations[0]); p.version = '2'; p.body += '\nNeuer Schluss';
  await assert.rejects(() => f.publish('personalization', p), /Review gehört/);
  p.review.approvedContentHash = reviewContentHash(p); const changed = await f.publish('personalization', p);
  assert.equal((await f.service.preview(id)).body, one.preview.body);
  await assert.rejects(() => f.service.enroll({ experimentId: f.applied.$id, assessmentId: p.assessmentId, contactId: p.contactId, personalizationVersionId: changed.id }), /anderen Mailversion/);
  const again = await f.service.enroll({ experimentId: f.applied.$id, assessmentId: 'as1', contactId: 'ct1', personalizationVersionId: one.frozen.id });
  assert.equal(again.variant_id, one.enrollment.variant_id);
  await f.repo.update('outreach_enrollments', again.$id, { snapshot_json: JSON.stringify({ ...JSON.parse(again.snapshot_json), personalization: { ...one.frozen, version: 'tampered' } }) });
  await assert.rejects(() => f.service.preview(id), /verändert/);
});

test('missing, foreign, inferred, stale sources and incomplete research cannot support a mail', async () => {
  for (const change of [
    async f => f.repo.update('evidence', 'ev1', { assessment_id: 'as2' }),
    async f => f.repo.update('evidence', 'ev1', { confidence: 'inferred' }),
    async f => f.repo.update('evidence', 'ev1', { observed_at: '2024-01-01T00:00:00Z' }),
    async f => f.repo.update('evidence', 'ev1', { source_quote: '' }),
    async f => f.repo.update('enrichments', 'en1', { status: 'pending' }),
    async f => f.repo.update('assessments', 'as1', { status: 'excluded' }),
  ]) { const f = await contentFixture(); await change(f); await assert.rejects(() => f.enroll()); assert.equal((await f.repo.list('outreach_messages')).length, 0); }
  const f = await contentFixture(); f.personalizations[0].review.checks.pop();
  await assert.rejects(() => f.enroll(), /Prüfpunkte/);
});

test('editorial preview needs no invented mailbox and pending review cannot enroll', async () => {
  const f = await contentFixture(); const p = structuredClone(f.personalizations[0]); p.contactId = null;
  p.review = { ...p.review, status: 'pending', approvedContentHash: '', checks: [] };
  const draft = await f.service.saveDraft({ clientId: 'own', kind: 'personalization', definition: p });
  const preview = await f.service.previewDraft({ draftId: draft.id });
  assert.equal(preview.provenance.contactConfirmed, false); assert.equal(preview.sendAuthorized, false);
  const frozen = await f.service.publishDraft({ draftId: draft.id, expectedHash: draft.contentHash });
  await assert.rejects(() => f.service.enroll({ experimentId: f.applied.$id, assessmentId: 'as1', contactId: 'ct1', personalizationVersionId: frozen.id }), /passen nicht/);
  assert.equal((await f.repo.list('outreach_messages')).length, 0);
});

test('only declared subject dimension is accepted; no template expressions or body variant injection', async () => {
  const f = await contentFixture();
  for (const mutate of [e => { e.variable = 'cta'; }, e => { e.body = 'common'; }, e => { e.variants[0].body = 'other'; }, e => { e.variants[1].subjectMethod = e.variants[0].subjectMethod; }]) {
    const e = structuredClone(f.experiment); mutate(e); assert.throws(() => validateExperiment(e));
  }
  const p = structuredClone(f.personalizations[0]); p.review.status = 'pending'; p.body += '{{ arbitrary.expression }}';
  assert.throws(() => validateProfile('personalization', p), /Template/);
  p.body = f.personalizations[0].body; p.subjects.a = 'Betreff\r\nBcc: other@example.invalid';
  assert.throws(() => validateProfile('personalization', p));
  const original = await f.enroll();
  await f.repo.update('evidence', 'ev2', { source_quote: 'Geändert nach Veröffentlichung' });
  const second = await f.publish('personalization', f.personalizations[1]);
  await f.repo.update('evidence', 'ev2', { source_quote: 'Nochmals verändert' });
  await assert.rejects(() => f.service.enroll({ experimentId: f.applied.$id, assessmentId: 'as2', contactId: 'ct2', personalizationVersionId: second.id }), /Belegstand/);
  assert.equal((await f.service.preview(original.enrollment.message_id)).subject, original.preview.subject);
});

test('accepted is not contacted; qualification requires booking evidence, cancellation and windows stay separate', async () => {
  const f = await contentFixture(); const messageId = await f.send(); await f.enroll(1);
  let group = (await f.service.report(f.applied.$id)).variants.find(v => v.providerAccepted);
  assert.equal(group.contactedCompanies, 0); assert.equal(group.acceptedWithoutContactEvidence, 1); assert.equal(group.primaryRate, null);
  const base = { messageId, occurredAt: '2026-09-12T10:00:00Z', source: 'manual-test' };
  const booking = { id: 'booking-1', evidence: 'Simulierte Kalenderbestätigung' };
  const qualification = { need: 'Konkreter betrieblicher Bedarf', decisionPath: 'Entscheider im Gespräch', checkedBy: 'Test', evidence: 'Fiktives Telefonat' };
  await assert.rejects(() => f.service.recordOutcome({ ...base, type: 'meeting_qualified', sourceId: 'bad', booking, qualification }), /Buchung fehlt/);
  await f.service.recordOutcome({ ...base, type: 'reply_positive', sourceId: 'reply' });
  group = (await f.service.report(f.applied.$id)).variants.find(v => v.providerAccepted);
  assert.equal(group.contactedCompanies, 1); assert.equal(group.meetingsBooked, 0);
  await f.service.recordOutcome({ ...base, type: 'meeting_booked', sourceId: 'booking', booking });
  await assert.rejects(() => f.service.recordOutcome({ ...base, type: 'meeting_qualified', sourceId: 'bad2', booking }), /Bedarf/);
  const outcome = { ...base, type: 'meeting_qualified', sourceId: 'qualified', booking, qualification };
  await f.service.recordOutcome(outcome); assert.equal((await f.service.recordOutcome(outcome)).inserted, false);
  f.time('2026-09-23T10:00:00Z');
  group = (await f.service.report(f.applied.$id)).variants.find(v => v.providerAccepted);
  assert.equal(group.matureCompanies, 1); assert.equal(group.primaryRate, 1); assert.equal(group.positiveRate, 1);
  await f.service.recordOutcome({ ...base, occurredAt: '2026-09-13T10:00:00Z', type: 'meeting_cancelled', sourceId: 'cancel', booking });
  group = (await f.service.report(f.applied.$id)).variants.find(v => v.providerAccepted);
  assert.equal(group.primaryRate, 0); assert.equal(group.meetingsBooked, 1); assert.equal(group.meetingsCancelled, 1);
  assert.equal((await f.service.report(f.applied.$id)).automaticWinner, null);
});

test('approved mail cannot send outside frozen experiment window', async () => {
  const f = await contentFixture(); const x = await f.enroll();
  await f.service.permission({ clientId: 'own', contactId: 'ct1', status: 'verified', basis: 'internal_test', providerAllowed: true, evidence: 'Test', checkedBy: 'Test' });
  await f.service.approve({ messageId: x.enrollment.message_id, contentHash: x.preview.contentHash, approvedBy: 'Test' });
  await f.service.experimentStatus({ experimentId: f.applied.$id, status: 'active' });
  f.time('2026-09-26T10:00:00Z');
  await assert.rejects(() => f.service.sendOne({ messageId: x.enrollment.message_id, execute: true }), /Testfenster/);
  assert.equal(f.provider.sent.length, 0);
});

test('failed early attempt cannot start the measurement window before evidenced transmission', async () => {
  const f = await contentFixture(); const messageId = await f.send();
  await f.repo.create('outreach_attempts', 'earlier-failed', { client_id: 'own', message_id: messageId, status: 'rejected', attempted_at: '2026-09-01T10:00:00Z' });
  const message = await f.repo.get('outreach_messages', messageId);
  await f.service.addEvent(message, 'provider_sent', '2026-09-12T10:00:00Z', { providerMessageId: message.provider_message_id }, 'sent-proof');
  f.time('2026-09-20T10:00:00Z');
  const booking = { id: 'later-booking', evidence: 'Fiktiver Kalenderbeleg' };
  const base = { messageId, occurredAt: '2026-09-20T10:00:00Z', source: 'Test' };
  await f.service.recordOutcome({ ...base, type: 'meeting_booked', sourceId: 'booked', booking });
  await f.service.recordOutcome({ ...base, type: 'meeting_qualified', sourceId: 'qualified', booking,
    qualification: { need: 'Testbedarf', decisionPath: 'Testentscheider', checkedBy: 'Test', evidence: 'Testgespräch' } });
  let group = (await f.service.report(f.applied.$id)).variants.find(v => v.providerAccepted);
  assert.equal(group.matureCompanies, 0); assert.equal(group.primaryRate, null);
  assert.equal(group.windowStarts[0].at, '2026-09-12T10:00:00.000Z');
  f.time('2026-09-23T10:00:00Z');
  group = (await f.service.report(f.applied.$id)).variants.find(v => v.providerAccepted);
  assert.equal(group.qualifiedBookedWithinWindow, 1); assert.equal(group.primaryRate, 1);
});

test('human response proves contact but ambiguous attempts leave its measurement start open', async () => {
  const f = await contentFixture(); const messageId = await f.send();
  await f.repo.create('outreach_attempts', 'earlier-unclear', { client_id: 'own', message_id: messageId, status: 'unknown', attempted_at: '2026-09-01T10:00:00Z' });
  await f.service.recordOutcome({ messageId, type: 'reply_positive', sourceId: 'reply', source: 'Test', occurredAt: '2026-09-12T10:00:00Z' });
  f.time('2026-09-23T10:00:00Z');
  const group = (await f.service.report(f.applied.$id)).variants.find(v => v.providerAccepted);
  assert.equal(group.contactedCompanies, 1); assert.equal(group.unknownContactTime, 1);
  assert.equal(group.matureCompanies, 0); assert.equal(group.primaryRate, null);
});

test('HTTP authoring uses same save, optimistic edit, publish, briefing, preview and apply path', async () => {
  const f = await contentFixture(); const token = 'b'.repeat(64); const server = createApi({ service: f.service, repo: f.repo, env: {}, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', value) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) });
    return { status: r.status, data: await r.json() };
  };
  try {
    assert.equal((await request('/v1/content-schemas')).data.experiment.properties.schemaVersion.const, 2);
    const saved = await request('/v1/drafts', 'POST', { clientId: 'own', kind: 'personalization', definition: f.personalizations[0] }); assert.equal(saved.status, 200);
    assert.equal((await request('/v1/drafts/' + saved.data.id, 'PATCH', { definition: f.personalizations[0], expectedHash: 'old' })).status, 400);
    assert.equal((await request('/v1/drafts/' + saved.data.id + '/preview')).data.candidates.length, 2);
    const published = await request('/v1/versions', 'POST', { draftId: saved.data.id, expectedHash: saved.data.contentHash }); assert.equal(published.status, 200);
    assert.equal(contentHash(parse((await request('/v1/versions/' + published.data.id + '/export')).data.yaml)), saved.data.contentHash);
    assert.equal((await request('/v1/briefings', 'POST', { clientId: 'own', experimentVersionId: f.version.id, assessmentId: 'as1', contactId: 'ct1' })).data.strategy.definition.objective, f.strategy.objective);
    const applied = await request('/v1/experiments/apply', 'POST', { clientId: 'own', campaignId: 'camp', versionId: f.version.id }); assert.equal(applied.data.$id, f.applied.$id);
    const enrolled = await request('/v1/enrollments', 'POST', { experimentId: applied.data.$id, assessmentId: 'as1', contactId: 'ct1', personalizationVersionId: published.data.id }); assert.equal(enrolled.status, 200);
    assert.equal((await request('/v1/messages/' + enrolled.data.message_id + '/preview')).data.body, f.personalizations[0].body);
    assert.equal((await f.repo.list('outreach_attempts')).length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('fictional examples are validated drafts, with an unconfirmed contact and independent bodies', async () => {
  const processExample = validateProfile('personalization', await loadContentFile('outreach/personalizations/fictional-process-consulting.yaml'));
  const knowledgeExample = validateProfile('personalization', await loadContentFile('outreach/personalizations/fictional-knowledge-consulting.yaml'));
  assert.equal(knowledgeExample.contactId, null); assert.equal(processExample.review.status, 'pending'); assert.notEqual(processExample.body, knowledgeExample.body);
  assert.equal(knowledgeExample.supplementalEvidence[0].excerptKind, 'summary');
});
