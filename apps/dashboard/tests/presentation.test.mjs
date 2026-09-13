import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeFilters, filterResetUrl, recordedRate, overviewFeedback } from '../lib/presentation.mjs';
import { leadQuery } from '../lib/input.mjs';

test('Filteranzahl zählt auch ausdrücklich nicht gesperrte Firmen; Zurücksetzen erhält die Suche', () => {
  const query = leadQuery({ q: 'Muster & Partner', blocked: 'false', positive: 'true', fit: 'qualified', page: '3', sort: 'name_desc' });
  assert.equal(activeFilters(query), 3);
  assert.equal(filterResetUrl(query), '/leads?q=Muster+%26+Partner');
  assert.equal(activeFilters({}), 0);
  assert.equal(filterResetUrl({ page: '3' }), '/leads');
  assert.equal(leadQuery({outreach:'accepted'}).outreach, 'accepted');
});

test('Erfasste Teilquote braucht denselben Firmen-Nenner und darf keine Vollständigkeit vortäuschen', () => {
  const rate = {value:null,recordedValue:0.25,numerator:1,denominator:4,denominatorUnit:'companies',coverage:'partial'};
  assert.equal(recordedRate(rate), 'Erfasste E-Mail-Quote: 25 % · 1/4 Firmen');
  assert.equal(recordedRate({...rate,recordedValue:1,numerator:4}), 'Erfasste E-Mail-Quote: 100 % · 4/4 Firmen');
  assert.match(recordedRate(rate,'positive'), /^Erfasste Positivquote:/);
  assert.match(recordedRate(rate,'meeting'), /^Erfasste Terminquote:/);
  for (const invalid of [undefined, {...rate,recordedValue:null}, {...rate,recordedValue:0,numerator:0}, {...rate,denominator:0}, {...rate,numerator:5}, {...rate,denominatorUnit:'messages'}, {...rate,recordedValue:0.5}, {...rate,recordedValue:NaN}]) assert.equal(recordedRate(invalid), null);
});

test('Antwortverlauf schließt interne Notizen/Sperren aus und zeigt nur belegte weitere Reaktionen', async () => {
  const entry = (id,type,origin='outreach_event',messageId='mail-1') => ({id,type,origin,messageId});
  const rows = [entry('note','note','lead_activity'),entry('block','do_not_contact','lead_activity'),entry('manual','conversation_positive','lead_activity'),entry('reply','reply_negative'),entry('auto','auto_reply'),entry('booking','meeting_booked'),entry('unproven-booking','meeting_booked'),entry('unsubscribe','unsubscribed'),entry('operator-unsubscribe','unsubscribed'),entry('status','meeting_qualified'),entry('unknown','reply_positive','unknown'),entry('missing','meeting_booked','outreach_event','missing-mail')];
  const before = structuredClone(rows);
  const calls=[];
  const result = await overviewFeedback(rows, async id => { calls.push(id); if(id==='missing-mail') throw Error('unavailable'); return {timeline:[
    {...rows[5],details:{booking:{id:'booking-1',evidence:'Expliziter Buchungsbeleg'}}},
    {...rows[6],details:{booking:{id:'booking-2',evidence:' '}}},
    {...rows[7],details:{provider:'brevo',rawEvent:'unsubscribed'}},
    {...rows[8],details:{source:'Operator',note:'Interne Sperre'}},
  ]}; });
  assert.deepEqual(result.map(e=>e.id), ['manual','reply','booking','unsubscribe']);
  assert.deepEqual(calls,['mail-1','missing-mail']);
  assert.deepEqual(rows,before,'Vollständiger Quellverlauf bleibt unverändert');
});
