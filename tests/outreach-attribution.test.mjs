import test from 'node:test';
import assert from 'node:assert/strict';
import {outreachLink} from '../src/outreach/attribution.mjs';
test('message correlation keeps unrelated query parameters and does not add personal data',()=>{
 const id='msg_0123456789abcdef0123456789ab';
 const url=new URL(outreachLink('https://example.invalid/call?utm_source=mail&topic=KI%20%26%20Team',id));
 assert.equal(url.searchParams.get('outreach_id'),id);assert.equal(url.searchParams.get('topic'),'KI & Team');assert.equal(url.searchParams.get('utm_source'),'mail');
 assert.equal(outreachLink(url.href,id),url.href);
 assert.throws(()=>outreachLink('https://example.invalid/call','person@example.invalid'));
 assert.throws(()=>outreachLink('http://example.invalid/call',id));
});
