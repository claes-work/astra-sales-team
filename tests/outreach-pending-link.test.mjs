import test from 'node:test';
import assert from 'node:assert/strict';
import { contentFixture } from './helpers/outreach-content.mjs';
import { reviewContentHash, validateProfile } from '../src/outreach/profiles.mjs';

test('unresolved link can be saved, previewed and versioned but cannot enroll or receive editorial approval', async () => {
  const f = await contentFixture();
  const strategy = structuredClone(f.strategy); strategy.version = 'pending-link'; strategy.preferredAction = 'link';
  await f.publish('strategy', strategy);
  const experiment = structuredClone(f.experiment); experiment.version = 'pending-link'; experiment.strategy.version = strategy.version;
  const ev = await f.publish('experiment', experiment);
  const applied = await f.service.applyExperimentVersion({clientId:'own', campaignId:'camp', versionId:ev.id});
  const p = structuredClone(f.personalizations[0]);
  p.strategy.version = strategy.version; p.experiment.version = experiment.version;
  p.review = {...p.review, status:'pending', checks:[], approvedContentHash:''};
  p.action = {kind:'link', text:'Ablauf und Terminwahl', url:null};
  p.body = `${p.salutation}\n\nIndividueller Testtext.\n\nAblauf und Terminwahl: [FUNNEL_LINK_OFFEN]`;
  const draft = await f.service.saveDraft({clientId:'own',kind:'personalization',definition:p});
  const preview = await f.service.previewDraft({draftId:draft.id});
  assert.equal(preview.sendAuthorized,false);
  assert.match(preview.candidates[0].body,/\[FUNNEL_LINK_OFFEN\]/);
  const frozen = await f.service.publishDraft({draftId:draft.id,expectedHash:draft.contentHash});
  await assert.rejects(()=>f.service.enroll({experimentId:applied.$id,assessmentId:p.assessmentId,contactId:p.contactId,personalizationVersionId:frozen.id}),/Review fehlt/);
  for (const status of ['pending','needs_research']) assert.doesNotThrow(()=>validateProfile('personalization',{...p,review:{...p.review,status}}));
  const approved = structuredClone(p); approved.review.status='approved'; approved.review.approvedContentHash=reviewContentHash(approved);
  await assert.rejects(()=>f.service.saveDraft({clientId:'own',kind:'personalization',definition:approved,expectedHash:draft.contentHash}),/Offener Funnel-Link/);
  const disguisedReply = structuredClone(approved); disguisedReply.action={kind:'reply',text:'Antworten',url:''};
  disguisedReply.review.approvedContentHash=reviewContentHash(disguisedReply);
  assert.throws(()=>validateProfile('personalization',disguisedReply),/Offener Funnel-Link/);
  assert.equal((await f.repo.list('outreach_messages')).length,0);
  assert.equal(f.provider.sent.length,0);
});

test('link resolution needs HTTPS, body consistency and removal of unresolved marker', async () => {
  const f = await contentFixture(); const p=structuredClone(f.personalizations[0]);
  p.review.status='pending'; p.action={kind:'link',text:'Termin',url:null};
  p.body=`${p.salutation}\nTermin`;
  assert.throws(()=>validateProfile('personalization',p),/Offener Funnel-Link/);
  for(const url of ['http://example.invalid/book','javascript:alert(1)','https://user:pass@example.invalid/book']) {
    p.action.url=url; p.body=`${p.salutation}\nTermin: ${url}`;
    assert.throws(()=>validateProfile('personalization',p));
  }
  p.action.url='https://example.invalid/book'; p.body=`${p.salutation}\nTermin: ${p.action.url} [FUNNEL_LINK_OFFEN]`;
  assert.throws(()=>validateProfile('personalization',p),/offenen Link-Marker/);
  p.body=`${p.salutation}\nTermin: ${p.action.url}`;
  assert.doesNotThrow(()=>validateProfile('personalization',p));
});
