import test from 'node:test';
import assert from 'node:assert/strict';
import {contentFixture} from './helpers/outreach-content.mjs';

test('editorial choice uses a reviewed candidate, preserves one message and rejects reassignment',async()=>{
 const f=await contentFixture();const version=await f.publish('personalization',f.personalizations[0]);
 const input={experimentId:f.applied.$id,assessmentId:'as1',contactId:'ct1',personalizationVersionId:version.id};
 await assert.rejects(()=>f.service.enroll({...input,variantSelection:{id:'missing',by:'Reviewer',reason:'Pilot'}}),/Betreffauswahl/);
 const selected={...input,variantSelection:{id:'b',by:'Reviewer',reason:'Individual pilot, not randomized'}};
 const row=await f.service.enroll(selected);
 assert.equal(row.variant_id,'b');assert.equal(JSON.parse(row.snapshot_json).variantSelection.method,'editorial_not_randomized');
 assert.equal((await f.service.preview(row.message_id)).subject,f.personalizations[0].subjects.b);
 assert.equal((await f.service.enroll(selected)).message_id,row.message_id);
 await assert.rejects(()=>f.service.enroll({...input,variantSelection:{id:'a',by:'Reviewer',reason:'Changed'}}),/andere.*Betreffauswahl/);
 assert.equal((await f.repo.list('outreach_messages')).length,1);
});
