import test from 'node:test';
import assert from 'node:assert/strict';
import {contentFixture} from './helpers/outreach-content.mjs';
import {reviewContentHash} from '../src/outreach/profiles.mjs';
async function revision(f){const p=structuredClone(f.personalizations[0]);p.version='2';p.body+='\nNeue gewünschte Ergänzung.';p.review.approvedContentHash=reviewContentHash(p);return f.publish('personalization',p);}
test('unsent revision retains stable message ID and old version, invalidates stale approval and audits change',async()=>{
 const f=await contentFixture(),before=await f.enroll();const version=await revision(f);
 const input={messageId:before.enrollment.message_id,personalizationVersionId:version.id,expectedHash:before.preview.contentHash,revisedBy:'Test',reason:'User-requested change'};
 await f.service.reviseUnsent(input);const after=await f.service.preview(input.messageId);
 assert.equal(after.messageId,before.preview.messageId);assert.notEqual(after.contentHash,before.preview.contentHash);assert.equal(after.status,'draft');
 assert.equal((await f.service.getContent({id:before.frozen.id,version:true})).contentHash,before.frozen.contentHash);
 assert.equal((await f.repo.list('outreach_messages')).length,1);assert.equal((await f.repo.list('outreach_events')).filter(e=>e.event_type==='message_revised').length,1);
 await assert.rejects(()=>f.service.reviseUnsent(input),/Aktueller Inhaltsstand/);
});
test('any send attempt blocks changing even an apparently approved message',async()=>{
 const f=await contentFixture(),before=await f.enroll(),version=await revision(f);
 await f.repo.create('outreach_attempts','test-reservation',{message_id:before.enrollment.message_id,status:'unknown'});
 await assert.rejects(()=>f.service.reviseUnsent({messageId:before.enrollment.message_id,personalizationVersionId:version.id,expectedHash:before.preview.contentHash,revisedBy:'Test',reason:'Change'}),/Versandversuch/);
 assert.equal((await f.service.preview(before.enrollment.message_id)).contentHash,before.preview.contentHash);
});
