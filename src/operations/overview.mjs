import { BERLIN,dayKey } from './time.mjs';
import { dayContext } from '../outreach/service.mjs';
import { quizSubmissions } from '../integrations/website-quiz.mjs';
const details=row=>{try{return JSON.parse(row.details_json||'{}');}catch{return {};}};
const text=x=>typeof x==='string'&&Boolean(x.trim());
const replies=new Set(['reply_received','reply_positive','reply_negative','reply_question']);
const reactions=new Set([...replies,'auto_reply','unsubscribed','meeting_booked','meeting_cancelled','meeting_held','meeting_qualified','meeting_disqualified']);
const companyKey=row=>JSON.stringify([row.client_id,row.company_id]);
const unique=rows=>new Set(rows.map(companyKey)).size;
function validData(d,now){
  const companies=new Map(d.companies.map(c=>[c.$id,c]));
  const messages=new Map(d.outreach_messages.filter(m=>companies.get(m.company_id)?.client_id===m.client_id).map(m=>[m.$id,m]));
  const attempts=d.outreach_attempts.filter(a=>Number.isFinite(Date.parse(a.attempted_at))&&Date.parse(a.attempted_at)<=now.getTime());
  const events=d.outreach_events.filter(e=>{
    const m=messages.get(e.message_id),at=Date.parse(e.occurred_at);
    return m&&m.client_id===e.client_id&&Number.isFinite(at)&&at<=now.getTime()
      &&attempts.some(a=>a.message_id===m.$id&&a.client_id===m.client_id&&Date.parse(a.attempted_at)<=at);
  });
  const activities=d.lead_activities.filter(a=>companies.get(a.company_id)?.client_id===a.client_id
    &&Number.isFinite(Date.parse(a.occurred_at))&&Date.parse(a.occurred_at)<=now.getTime()
    &&(!a.message_id||(messages.get(a.message_id)?.company_id===a.company_id&&messages.get(a.message_id)?.client_id===a.client_id)));
  return{companies,messages,events,activities};
}
function metric(count,unit,note,coverage='partial'){
  return{value:count>0||coverage==='recorded'?count:null,recordedCount:count,unit,coverage,note};
}
function mailMetric(es,messages,note){
  const rows=[...new Map(es.map(e=>[e.message_id,messages.get(e.message_id)])).values()];
  const contacts=new Set(rows.filter(m=>m.contact_id).map(m=>JSON.stringify([m.client_id,m.contact_id])));
  return{...metric(unique(rows),'companies',note),messageCount:rows.length,
    contactCount:rows.every(m=>m.contact_id)?contacts.size:null,knownContactCount:contacts.size,eventCount:es.length};
}
export function overviewSuccess(d,now){
  const {messages,events,activities}=validData(d,now);
  const mailReplies=events.filter(e=>replies.has(e.event_type)),positiveReplies=events.filter(e=>e.event_type==='reply_positive');
  const manual=activities.filter(a=>a.type==='conversation_positive');
  const messageRows=es=>es.map(e=>messages.get(e.message_id));
  const sent=[...messages.values()].filter(m=>d.facts.get(m.$id)?.sentAt),sentIds=new Set(sent.map(m=>m.$id)),sentCompanies=unique(sent);
  // Count booking identities, not arbitrary meeting events. Multiple possible mail
  // attributions of the same booking stay out of mail-conversion numerators.
  const groups=Map.groupBy(events.filter(e=>e.event_type==='meeting_booked'&&text(details(e).booking?.id)&&text(details(e).booking?.evidence)),e=>JSON.stringify([e.client_id,details(e).booking.id]));
  const bookings=[];
  for(const [key,booked]of groups){
    const first=Math.min(...booked.map(e=>Date.parse(e.occurred_at)));
    if(events.some(e=>e.event_type==='meeting_cancelled'&&JSON.stringify([e.client_id,details(e).booking?.id])===key&&Date.parse(e.occurred_at)>=first&&text(details(e).booking?.evidence)))continue;
    bookings.push({key,booked,messageIds:[...new Set(booked.map(e=>e.message_id))]});
  }
  const attributed=bookings.filter(b=>b.messageIds.length===1&&sentIds.has(b.messageIds[0]));
  const rate=(numerator,label)=>({value:null,recordedValue:sentCompanies>0&&numerator>0?numerator/sentCompanies:null,
    numerator,denominator:sentCompanies,denominatorUnit:'companies',coverage:'partial',
    denominatorDefinition:'Eindeutige Firmen mit mindestens einer Nachricht mit Versand- oder Zustellbeleg; Zähler nur an genau so einer Nachricht dokumentiert.',
    note:`${label}: nur gespeicherte Belege zum Stichtag. Erfassung unvollständig; keine vollständige Konversionsquote oder gemeinsame A/B-Beobachtungsfrist.`});
  return{scope:'all_time_as_of',asOf:now.toISOString(),
    sentMessages:metric(sent.length,'messages','In dieser Datenbank belegte Sendungen. API-Annahmen separat; Zustellzeit-Ersatz bleibt in den bestehenden Zeitfeldern erkennbar.','recorded'),
    openedMessages:metric(new Set(events.filter(e=>e.event_type==='opened').map(e=>e.message_id)).size,'messages','Nachrichten mit explizitem Öffnungsereignis, jeweils einmal gezählt. Automatische Abrufe sind möglich; kein Nachweis menschlichen Lesens. proxy_open zählt nicht. Erfassung unvollständig.'),
    clickedMessages:metric(new Set(events.filter(e=>e.event_type==='clicked').map(e=>e.message_id)).size,'messages','Nachrichten mit explizitem Klickereignis, jeweils einmal gezählt. Sicherheitsprüfungen können automatisch klicken; kein bestätigter menschlicher Besuch oder Termin. Erfassung unvollständig.'),
    completedQuizzes:metric(quizSubmissions(d,now).length,'submissions','Validierte, dauerhaft zugeordnete Website-Quiz-Abschlüsse; jede Quellabgabe einmal. Testdaten und nicht zugeordnete Abschlüsse ausgeschlossen. Formularidentität kann vom Mail-Empfänger abweichen; keine Buchung und keine vollständige Trichterquote.'),
    feedback:metric(unique([...messageRows(mailReplies),...manual]),'companies','Firmen mit expliziter Mailantwort oder ausdrücklich positiver manueller Rückmeldung. Allgemeine Notiz und automatische Antwort zählen nicht.'),
    positiveFeedback:metric(unique([...messageRows(positiveReplies),...manual]),'companies','Firmen mit mindestens einer explizit positiven Rückmeldung; keine Buchung und keine Aussage über den neuesten Gesprächsstatus.'),
    emailReplies:mailMetric(mailReplies,messages,'Nur explizite menschliche Mailantwort-Ereignisse. Inbound-Abgleich nicht als vollständig bestätigt.'),
    positiveEmailReplies:mailMetric(positiveReplies,messages,'Mindestens eine ausdrücklich positiv klassifizierte Mailantwort; manuelle Lead-Aktivität reicht nicht.'),
    manualPositiveFeedback:{...metric(unique(manual),'companies','Nur ausdrücklich positive manuelle Rückmeldungen; auch mit Mailverknüpfung keine automatische Antwortklassifikation.','manual_only'),activityCount:manual.length},
    confirmedMeetings:{...metric(bookings.length,'bookings','Buchungskennung plus Beleg, ohne belegte Absage. Kein vollständiger automatischer Buchungsimport; keine automatische Qualifizierung.','manual_only'),
      attributedToSentMessages:attributed.length,ambiguousMailAttribution:bookings.filter(b=>b.messageIds.length>1).length,
      eventsWithoutBookingEvidence:events.filter(e=>e.event_type==='meeting_booked'&&(!text(details(e).booking?.id)||!text(details(e).booking?.evidence))).length},
    rates:{emailReply:rate(unique(messageRows(mailReplies.filter(e=>sentIds.has(e.message_id)))),'Mailantworten'),
      positiveEmailReply:rate(unique(messageRows(positiveReplies.filter(e=>sentIds.has(e.message_id)))),'Positive Mailantworten'),
      meeting:rate(unique(attributed.map(b=>messages.get(b.messageIds[0]))),'Belegte Buchungen')},
    note:'Gesamtbestand je Auftraggeber/Firmenidentität, kein Zeitraumfilter. Mehrere Mails oder Notizen derselben Firma ergeben nicht mehrere Antwortende. Leere Beleglage ist unbekannt, keine gemessene Erfolglosigkeit.'};
}
export function overviewUsage(d,{controls,ramp,env},now){
  const attempts=d.outreach_attempts.filter(a=>Number.isFinite(Date.parse(a.attempted_at))&&Date.parse(a.attempted_at)<=now.getTime());
  const reservationsToday=attempts.filter(a=>dayKey(a.attempted_at)===dayKey(now)).length;
  const reservationsLast24h=attempts.filter(a=>now-Date.parse(a.attempted_at)<86400000).length;
  const configuredDailyLimit=Number.isInteger(controls?.daily_limit)&&ramp?.configured&&Number.isFinite(ramp.safeLimit)?Math.min(controls.daily_limit,ramp.safeLimit):null;
  const paused=controls?.paused!==false||ramp?.state?.paused===true,sendEnabled=env?.OUTREACH_SEND_ENABLED==='true';
  const reasons=[];
  if(paused)reasons.push('Versand pausiert');
  if(!sendEnabled)reasons.push('Lokale Versandaktivierung fehlt');
  if(configuredDailyLimit===null)reasons.push('Grenzen nicht vollständig eingerichtet');
  if(ramp?.blocked)reasons.push(ramp.reason||'Versandaufbau blockiert');
  if(configuredDailyLimit===0)reasons.push('Versandgrenze ist null');
  const effectiveDailyLimit=reasons.length?0:configuredDailyLimit;
  const remainingCapacity=configuredDailyLimit===null?null:Math.max(0,Math.min(configuredDailyLimit-reservationsToday,configuredDailyLimit-reservationsLast24h));
  if(remainingCapacity===0)reasons.push('Kontingent für Berliner Tag oder rollierende 24 Stunden ausgeschöpft');
  let sendWindowOpen=null;
  if(controls){try{const local=dayContext(now,controls.timezone);sendWindowOpen=local.hour>=controls.start_hour&&local.hour<controls.end_hour&&(!controls.weekdays_only||!local.weekend);}catch{}}
  if(sendWindowOpen!==true)reasons.push('Versandzeitfenster geschlossen oder unbekannt');
  const last=Math.max(...attempts.map(a=>Date.parse(a.attempted_at)));
  if(Number.isFinite(last)&&now-last<controls?.min_interval_seconds*1000)reasons.push('Mindestabstand noch nicht abgelaufen');
  return{day:dayKey(now),timezone:BERLIN,configuredDailyLimit,effectiveDailyLimit,reservationsToday,reservationsLast24h,
    remainingCapacity,availableNow:reasons.length?0:remainingCapacity,paused,sendEnabled,sendWindowOpen,blockingReasons:reasons,
    note:'Nutzung zählt dauerhaft reservierte Versuche einschließlich abgelehnter/unklarer Versuche, nicht erfolgreiche Sendungen. Verfügbare Kapazität ersetzt keine Empfänger-/Inhaltsfreigabe oder Anbieterprüfung.'};
}
export function recentActivity(d,now){
  const {companies,messages,events,activities}=validData(d,now);
  const entries=[
    ...events.filter(e=>reactions.has(e.event_type)).map(e=>({id:e.$id,origin:'outreach_event',type:e.event_type,at:e.occurred_at,source:details(e).source??details(e).provider??null,
      channel:replies.has(e.event_type)||e.event_type==='auto_reply'?'email':null,companyId:messages.get(e.message_id).company_id,messageId:e.message_id,summary:details(e).note||messages.get(e.message_id).subject||''})),
    ...activities.map(a=>({id:a.$id,origin:'lead_activity',type:a.type,at:a.occurred_at,source:details(a).source??null,channel:a.channel,companyId:a.company_id,messageId:a.message_id??null,summary:details(a).note||''})),
  ];
  return [...new Map(entries.map(e=>[`${e.origin}:${e.id}`,e])).values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id)).slice(0,12)
    .map(e=>({...e,summary:String(e.summary).slice(0,240),companyName:companies.get(e.companyId).name,
      target:{type:e.messageId?'message':'company',id:e.messageId??e.companyId}}));
}
