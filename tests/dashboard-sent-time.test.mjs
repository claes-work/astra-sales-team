import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardData, mailFacts } from '../src/operations/dashboard.mjs';
import { MemoryRepo } from './helpers/outreach-content.mjs';

async function fixture({attemptedAt,deliveredAt,now}) {
  const repo=new MemoryRepo();
  const dashboard=new DashboardData({repo,now:()=>new Date(now),lock:work=>work(),ramp:{snapshot:async()=>({configured:false})}});
  await repo.create('companies','co',{client_id:'own',name:'Testfirma',domain:'example.invalid'});
  await repo.create('outreach_messages','mail',{client_id:'own',company_id:'co',status:'sent',subject:'Test'});
  await repo.create('outreach_attempts','attempt',{client_id:'own',message_id:'mail',status:'accepted',attempted_at:attemptedAt});
  const event=async(id,type,at,client='own')=>repo.create('outreach_events',id,{client_id:client,message_id:'mail',event_type:type,occurred_at:at});
  if(deliveredAt)await event('delivery','delivered',deliveredAt);
  return{repo,dashboard,event};
}

test('Zustellung nach Berliner Mitternacht bleibt Tagesproxy; späterer Versandbeleg korrigiert den Tag ohne Doppelzählung',async()=>{
  const f=await fixture({attemptedAt:'2026-09-10T21:55:00Z',deliveredAt:'2026-09-10T22:02:00Z',now:'2026-09-12T12:00:00Z'});
  let report=await f.dashboard.day('2026-09-11');
  assert.equal(report.counts.sentMessages,1);
  assert.equal(report.counts.sentTimeProxyMessages,1);
  assert.equal(report.counts.sentTimeKnownMessages,0);
  assert.equal(report.sent[0].sentAtSource,'delivered');
  assert.equal(report.sent[0].sentAtIsProxy,true);
  assert.match(report.counts.sentTimeNote,/unbekannt/);
  await f.event('duplicate-delivery','delivered','2026-09-10T22:04:00Z');
  await f.event('late-imported-sent','provider_sent','2026-09-10T21:59:00Z');
  report=await f.dashboard.day('2026-09-10');
  assert.equal(report.counts.sentMessages,1);
  assert.equal(report.counts.sentTimeKnownMessages,1);
  assert.equal(report.counts.sentTimeProxyMessages,0);
  assert.equal(report.sent[0].sentAtSource,'provider_sent');
  assert.equal((await f.dashboard.day('2026-09-11')).counts.sentMessages,0);
  const detail=await f.dashboard.message('mail');
  assert.equal(detail.sentAt,'2026-09-10T21:59:00Z');
  assert.equal(detail.sentAtIsProxy,false);
  const overview=await f.dashboard.overview();
  assert.equal(overview.totals.sentMessages,1);
  assert.equal(overview.totals.sentTimeProxyMessages,0);
  assert.equal(overview.totals.deliveredMessages,1);
});

test('Sommerzeitwechsel und doppelte Winterzeitstunde bleiben getrennte UTC-Ereignisse mit ausdrücklicher Zeitquelle',async()=>{
  for(const [sent,delivered,day] of [
    ['2026-03-28T23:59:00Z','2026-03-29T01:01:00Z','2026-03-29'],
    ['2026-10-25T00:30:00Z','2026-10-25T01:30:00Z','2026-10-25'],
  ]){
    const f=await fixture({attemptedAt:new Date(Date.parse(sent)-60000).toISOString(),deliveredAt:delivered,now:'2026-10-26T12:00:00Z'});
    assert.equal((await f.dashboard.day(day)).counts.sentTimeProxyMessages,1);
    await f.event('sent','provider_sent',sent);
    const detail=await f.dashboard.message('mail');
    assert.equal(detail.sentAt,sent);
    assert.equal(detail.deliveredAt,delivered);
    const rows=(await f.dashboard.days()).items;
    assert.equal(rows.find(r=>r.day===day).sentTimeKnownMessages,1);
    assert.equal(rows.reduce((n,r)=>n+r.sentMessages,0),1);
  }
});

test('API-Annahme, fremde und zukünftige Ereignisse erfinden weder Versand noch Zeitquelle',async()=>{
  const f=await fixture({attemptedAt:'2026-09-10T10:00:00Z',now:'2026-09-10T12:00:00Z'});
  await f.event('other-client','delivered','2026-09-10T11:00:00Z','other');
  await f.event('future','provider_sent','2026-09-11T11:00:00Z');
  const detail=await f.dashboard.message('mail');
  assert.equal(detail.sentAt,null);
  assert.equal(detail.sentAtSource,null);
  assert.equal(detail.sentAtIsProxy,null);
  assert.equal(detail.acceptedAt,'2026-09-10T10:00:00Z');
  assert.equal((await f.dashboard.day('2026-09-10')).counts.sentMessages,0);
  assert.equal(mailFacts({$id:'missing',client_id:'own'},await f.repo.list('outreach_events'),[],new Date()).sentAt,null);
});
