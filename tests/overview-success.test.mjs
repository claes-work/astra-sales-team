import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepo } from './helpers/outreach-content.mjs';
import { DashboardData } from '../src/operations/dashboard.mjs';
import { overviewUsage } from '../src/operations/overview.mjs';
const now=new Date('2026-09-10T12:00:00Z');
async function fixture(){
  const repo=new MemoryRepo();
  const dashboard=new DashboardData({repo,now:()=>now,env:{},lock:work=>work(),ramp:{snapshot:async()=>({configured:true,safeLimit:5,state:{paused:false},blocked:false})}});
  await repo.create('outreach_controls','default',{paused:true,daily_limit:10,timezone:'Europe/Berlin',start_hour:9,end_hour:17,weekdays_only:true,min_interval_seconds:180});
  for(const id of ['a','b','c'])await repo.create('companies',id,{client_id:'own',name:`Firma ${id}`,domain:`${id}.invalid`});
  let n=0;
  const event=async(message,type,extra={},at='2026-09-10T11:00:00Z',client='own')=>repo.create('outreach_events',`e${++n}`,{client_id:client,message_id:message,event_type:type,occurred_at:at,details_json:JSON.stringify({source:'test evidence',...extra})});
  const mail=async(id,company,sent=true)=>{
    await repo.create('outreach_messages',id,{client_id:'own',company_id:company,contact_id:`contact-${company}`,subject:`Mail ${id}`,status:'sent'});
    await repo.create('outreach_attempts',id,{client_id:'own',message_id:id,status:'accepted',attempted_at:'2026-09-10T10:00:00Z'});
    if(sent)await event(id,'provider_sent',{},'2026-09-10T10:01:00Z');
  };
  const activity=async(company,type,messageId=null)=>dashboard.activity({companyId:company,type,channel:'phone',occurredAt:'2026-09-10T11:30:00Z',sourceId:`activity${++n}`,source:'Operator note',note:'Actual manual test note',by:'Tester',...(messageId?{messageId}:{})});
  return{repo,dashboard,event,mail,activity};
}
test('Leerer echter Kampagnenbestand liefert null bei unbekannten Erfolgen und Quoten, aber genaue erfasste Sendemenge',async()=>{
  const f=await fixture(),d=await f.dashboard.overview();
  assert.equal(d.success.sentMessages.value,0);
  for(const name of ['feedback','positiveFeedback','emailReplies','confirmedMeetings','openedMessages','clickedMessages']){
    assert.equal(d.success[name].value,null);assert.equal(d.success[name].recordedCount,0);
  }
  assert.equal(d.success.rates.emailReply.value,null);assert.equal(d.success.rates.emailReply.recordedValue,null);assert.equal(d.success.rates.emailReply.denominator,0);
  assert.equal(d.usage.configuredDailyLimit,5);assert.equal(d.usage.effectiveDailyLimit,0);assert.equal(d.usage.availableNow,0);assert.equal(d.usage.reservationsToday,0);
});

test('Öffnungen und Klicks zählen eindeutige Nachrichten, keine Proxys oder ungültigen Ereignisse',async()=>{
 const f=await fixture();await f.mail('a1','a');await f.mail('a2','a');await f.mail('b1','b');
 await f.event('a1','opened');await f.event('a1','opened');await f.event('a2','opened');
 await f.event('a1','clicked');await f.event('a1','clicked');await f.event('b1','proxy_open');
 await f.event('b1','opened',{},'2026-09-10T13:00:00Z');
 await f.event('b1','clicked',{},'2026-09-10T11:00:00Z','other');
 await f.event('b1','opened',{},'2026-09-10T09:00:00Z');
 await f.event('missing','clicked');
 const s=(await f.dashboard.overview()).success;
 assert.equal(s.openedMessages.recordedCount,2);assert.equal(s.openedMessages.value,2);
 assert.equal(s.clickedMessages.recordedCount,1);assert.equal(s.clickedMessages.value,1);
 for(const k of ['openedMessages','clickedMessages']){assert.equal(s[k].unit,'messages');assert.equal(s[k].coverage,'partial');assert.match(s[k].note,/utomatische|automatisch/);}
 assert.equal(s.confirmedMeetings.recordedCount,0);assert.equal(s.sentMessages.value,3);
});

test('Ein Proxy-Abruf oder Klick erzeugt keine angenommene Öffnung',async()=>{
 const f=await fixture();await f.mail('a1','a');await f.event('a1','proxy_open');await f.event('a1','clicked');
 const s=(await f.dashboard.overview()).success;assert.equal(s.openedMessages.value,null);assert.equal(s.openedMessages.recordedCount,0);assert.equal(s.clickedMessages.value,1);
});
test('Mehrere Mails/Klassifikationen/positive Notizen einer Firma zählen einmal; Telefon und unverknüpfte Rückmeldung verfälschen keine Mailquote',async()=>{
  const f=await fixture();await f.mail('a1','a');await f.mail('a2','a');await f.mail('b1','b');await f.mail('c1','c',false);
  await f.event('a1','reply_received');await f.event('a1','reply_positive');await f.event('a2','reply_positive');
  await f.event('b1','auto_reply');await f.event('c1','reply_received');
  await f.activity('b','conversation_positive');await f.activity('b','conversation_positive','b1');await f.activity('a','note');
  const {success:s}=await f.dashboard.overview();
  assert.equal(s.sentMessages.value,3);assert.equal(s.emailReplies.recordedCount,2);assert.equal(s.emailReplies.messageCount,3);assert.equal(s.emailReplies.contactCount,2);assert.equal(s.emailReplies.eventCount,4);
  assert.equal(s.feedback.recordedCount,3);assert.equal(s.positiveFeedback.recordedCount,2);
  assert.equal(s.positiveEmailReplies.recordedCount,1);assert.equal(s.manualPositiveFeedback.recordedCount,1);assert.equal(s.manualPositiveFeedback.activityCount,2);
  assert.equal(s.rates.emailReply.denominator,2);assert.equal(s.rates.emailReply.numerator,1);assert.equal(s.rates.emailReply.recordedValue,0.5);
  assert.equal(s.rates.emailReply.value,null);assert.equal(s.rates.positiveEmailReply.numerator,1);
});
test('Buchungen brauchen Beleg, zählen Identitäten statt Ereignisse; Absage und mehrdeutige Mailzuordnung verändern Zähler korrekt',async()=>{
  const f=await fixture();await f.mail('a1','a');await f.mail('a2','a');await f.mail('b1','b');
  await f.event('a1','reply_positive');await f.event('a1','meeting_booked');
  await f.event('a1','meeting_booked',{booking:{id:'one',evidence:'appointment receipt'}});
  await f.event('a1','meeting_booked',{booking:{id:'one',evidence:'duplicate receipt'}});
  let s=(await f.dashboard.overview()).success;assert.equal(s.confirmedMeetings.recordedCount,1);assert.equal(s.confirmedMeetings.eventsWithoutBookingEvidence,1);assert.equal(s.rates.meeting.numerator,1);
  await f.event('a2','meeting_booked',{booking:{id:'one',evidence:'ambiguous second message'}});
  s=(await f.dashboard.overview()).success;assert.equal(s.confirmedMeetings.recordedCount,1);assert.equal(s.confirmedMeetings.ambiguousMailAttribution,1);assert.equal(s.rates.meeting.numerator,0);
  await f.event('b1','meeting_booked',{booking:{id:'two',evidence:'other appointment'}});
  await f.event('a1','meeting_cancelled',{booking:{id:'one',evidence:'cancellation receipt'}},'2026-09-10T11:30:00Z');
  s=(await f.dashboard.overview()).success;assert.equal(s.confirmedMeetings.recordedCount,1);assert.equal(s.confirmedMeetings.attributedToSentMessages,1);assert.equal(s.rates.meeting.recordedValue,0.5);
});
test('Aktivitätsverlauf begrenzt und verlinkt echte Rückmeldungen; fremde, zukünftige und reine Versandereignisse fehlen',async()=>{
  const f=await fixture();await f.mail('a1','a');await f.event('a1','reply_positive',{},'2026-09-10T13:00:00Z');await f.event('a1','reply_received',{},'2026-09-10T11:00:00Z','other');
  await f.event('a1','reply_question',{},'2026-09-10T11:00:00Z');
  let d=await f.dashboard.overview();assert.equal(d.recentActivity.length,1);assert.equal(d.recentActivity[0].companyName,'Firma a');assert.deepEqual(d.recentActivity[0].target,{type:'message',id:'a1'});
  for(let i=0;i<14;i++)await f.activity('a','note');
  d=await f.dashboard.overview();assert.equal(d.recentActivity.length,12);assert.deepEqual(d.recentActivity[0].target,{type:'company',id:'a'});assert.equal(d.success.feedback.recordedCount,1);assert.equal(d.success.positiveFeedback.value,null);
});
test('Tagesnutzung bildet vorhandene Kalender-/24h-Reservierungen und Pause ab, ohne Kontrollen zu verändern',()=>{
  const d={outreach_attempts:[{attempted_at:'2026-09-09T20:00:00Z',status:'unknown'},{attempted_at:'2026-09-10T08:00:00Z',status:'rejected'},{attempted_at:'2026-09-11T08:00:00Z',status:'reserved'}]};
  const controls={paused:false,daily_limit:10,timezone:'Europe/Berlin',start_hour:9,end_hour:17,weekdays_only:true,min_interval_seconds:180};
  const ramp={configured:true,safeLimit:5,state:{paused:false},blocked:false},env={OUTREACH_SEND_ENABLED:'true'};
  const before=structuredClone({d,controls,ramp});const u=overviewUsage(d,{controls,ramp,env},now);
  assert.equal(u.reservationsToday,1);assert.equal(u.reservationsLast24h,2);assert.equal(u.configuredDailyLimit,5);assert.equal(u.remainingCapacity,3);assert.equal(u.availableNow,3);
  assert.deepEqual({d,controls,ramp},before);
  const paused=overviewUsage(d,{controls:{...controls,paused:true},ramp,env},now);assert.equal(paused.effectiveDailyLimit,0);assert.equal(paused.availableNow,0);assert.equal(paused.configuredDailyLimit,5);
});
