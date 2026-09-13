// A/B denominators require evidence of transmission or a human result, not enrollment/acceptance.
export function buildReport({ experiment, snapshot, enrollments, messages, events, attempts, now, simulation }) {
  const asOf = now.getTime();
  const days = snapshot.definition.responseWindowDays;
  const details = e => { try { return JSON.parse(e.details_json || '{}'); } catch { return {}; } };
  const validEvents = events.filter(e => e.client_id === experiment.client_id && Date.parse(e.occurred_at) <= asOf);
  const contactSignals = new Set(['provider_sent', 'delivered', 'reply_received', 'reply_positive', 'reply_negative', 'reply_question']);
  const result = { experimentId: experiment.$id, name: experiment.name, status: experiment.status, simulation,
    variable: snapshot.definition.variable, authoring: snapshot.definition.authoring ?? 'template-v1',
    primaryMetric: 'qualified_meeting_rate', asOf: now.toISOString(), responseWindowDays: days, automaticWinner: null,
    experimentVersion: snapshot.definition.version, definitionHash: experiment.definition_hash,
    strategyVersion: snapshot.contentVersion?.dependencies.strategy.version ?? null,
    enrollmentWindow: snapshot.definition.enrollmentWindow ?? null,
    denominatorDefinition: 'Firmen mit belegtem Versand (provider_sent), Zustellung oder menschlichem Ergebnis und vollständig abgelaufenem Beobachtungsfenster. Anbieterannahme allein zählt nicht.',
    windowStartDefinition: 'Frühestes belegtes Versand-/Zustellereignis; ohne diese Ereignisse nur ein eindeutig zuordenbarer angenommener Versuch plus menschlichem Ergebnis. Bei mehreren möglichen Versuchen bleibt der Fristbeginn offen.',
    attribution: 'Nur eindeutig zur Nachricht gespeicherte Ereignisse; kein automatischer Website-/Buchungsimport.', variants: [] };
  for (const variant of snapshot.definition.variants) {
    const group = enrollments.filter(e => e.variant_id === variant.id);
    const rows = group.map(e => messages.find(m => m.$id === e.message_id && m.client_id === experiment.client_id)).filter(Boolean);
    const forMessage = m => validEvents.filter(e => e.message_id === m.$id);
    const attemptsFor = m => attempts.filter(a => a.message_id === m.$id && a.client_id === experiment.client_id);
    const firstAttempt = m => Math.min(...attemptsFor(m).map(a => Date.parse(a.attempted_at)).filter(Number.isFinite));
    const contactEvidence = m => forMessage(m).filter(e => Date.parse(e.occurred_at) >= firstAttempt(m)
      && (contactSignals.has(e.event_type) || (e.event_type === 'meeting_booked' && details(e).booking?.id && details(e).booking?.evidence)));
    const origin = m => {
      const evidence = contactEvidence(m);
      const transmitted = evidence.filter(e => ['provider_sent', 'delivered'].includes(e.event_type))
        .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
      if (transmitted.length) return { at: Date.parse(transmitted[0].occurred_at), basis: transmitted[0].event_type };
      const eligible = attemptsFor(m).filter(a => ['accepted', 'unknown', 'reserved'].includes(a.status)
        && evidence.some(e => Date.parse(a.attempted_at) <= Date.parse(e.occurred_at)));
      if (eligible.length === 1 && eligible[0].status === 'accepted') return { at: Date.parse(eligible[0].attempted_at), basis: 'unique_accepted_attempt_with_human_result' };
      return { at: Infinity, basis: evidence.length ? 'unknown_contact_time' : 'no_contact_evidence' };
    };
    const start = m => origin(m).at;
    const has = (m, types, within = false) => forMessage(m).some(e => types.includes(e.event_type)
      && Date.parse(e.occurred_at) >= (within ? start(m) : firstAttempt(m)) && (!within || Date.parse(e.occurred_at) <= start(m) + days * 86400000));
    const accepted = rows.filter(m => attemptsFor(m).some(a => a.status === 'accepted'));
    const contacted = rows.filter(m => contactEvidence(m).length);
    const mature = contacted.filter(m => asOf - start(m) >= days * 86400000);
    const qualified = (m, cutoff) => {
      const es = forMessage(m).filter(e => Date.parse(e.occurred_at) >= firstAttempt(m) && Date.parse(e.occurred_at) <= cutoff);
      return es.some(e => {
        const data = details(e);
        if (e.event_type !== 'meeting_booked' || !data.booking?.id || !data.booking?.evidence) return false;
        const same = es.filter(x => details(x).booking?.id === data.booking.id && Date.parse(x.occurred_at) >= Date.parse(e.occurred_at));
        if (same.some(x => x.event_type === 'meeting_cancelled')) return false;
        const last = same.filter(x => ['meeting_qualified', 'meeting_disqualified'].includes(x.event_type))
          .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at) || b.event_type.localeCompare(a.event_type))[0];
        const q = last && details(last).qualification;
        return last?.event_type === 'meeting_qualified' && ['need', 'decisionPath', 'checkedBy', 'evidence'].every(k => typeof q?.[k] === 'string' && q[k].trim());
      });
    };
    const positive = mature.filter(m => has(m, ['reply_positive'], true)).length;
    const qualifiedWindow = mature.filter(m => qualified(m, start(m) + days * 86400000)).length;
    result.variants.push({ id: variant.id, subject: variant.subject ?? null, name: variant.name ?? variant.id, subjectMethod: variant.subjectMethod ?? null,
      assignedCompanies: group.length, providerAccepted: accepted.length, contactedCompanies: contacted.length,
      acceptedWithoutContactEvidence: accepted.filter(m => !contacted.includes(m)).length,
      matureCompanies: mature.length, pendingResponseWindow: contacted.length - mature.length,
      unknownContactTime: contacted.filter(m => !Number.isFinite(start(m))).length,
      windowStarts: contacted.map(m => ({ companyId: m.company_id, messageId: m.$id, basis: origin(m).basis,
        at: Number.isFinite(start(m)) ? new Date(start(m)).toISOString() : null })),
      qualifiedBookedWithinWindow: qualifiedWindow, primaryRate: mature.length ? qualifiedWindow / mature.length : null,
      positiveWithinWindow: positive, positiveRate: mature.length ? positive / mature.length : null,
      replies: rows.filter(m => has(m, ['reply_received', 'reply_positive', 'reply_negative', 'reply_question'])).length,
      meetingsBooked: rows.filter(m => has(m, ['meeting_booked'])).length,
      qualifiedMeetingsBooked: rows.filter(m => qualified(m, asOf)).length,
      meetingsHeld: rows.filter(m => has(m, ['meeting_held'])).length, meetingsCancelled: rows.filter(m => has(m, ['meeting_cancelled'])).length,
      negativeReplies: rows.filter(m => has(m, ['reply_negative'])).length, unsubscribed: rows.filter(m => has(m, ['unsubscribed'])).length,
      workshopsWon: rows.filter(m => has(m, ['workshop_won'])).length, delivered: rows.filter(m => has(m, ['delivered'])).length,
      bounced: rows.filter(m => has(m, ['hard_bounce', 'soft_bounce', 'invalid_email'])).length,
      opensDiagnostic: rows.filter(m => has(m, ['opened', 'proxy_open'])).length, clicksDiagnostic: rows.filter(m => has(m, ['clicked'])).length,
      unknownAttempts: rows.filter(m => attemptsFor(m).some(a => ['unknown', 'reserved'].includes(a.status))).length,
      personalizationVersions: group.map(e => { const p = JSON.parse(e.snapshot_json).personalization; return p ? { companyId: e.company_id, id: p.id, version: p.version, contentHash: p.contentHash } : null; }).filter(Boolean),
    });
  }
  return result;
}

export function markdownReport(report) {
  const text = value => String(value ?? '–').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
  const lines = [`# ${report.simulation ? 'Software-Demo: ' : ''}${text(report.name)}`, '',
    ...(report.simulation ? ['**Fiktive Firmen und simulierte Ergebnisse. Keine E-Mails versendet.**', ''] : []),
    `Status: ${report.status} · Variable: Betreff · Beobachtungsfenster: ${report.responseWindowDays} Tage`, '',
    '**Hauptgröße: belegte qualifizierte Buchungen je nachweislich kontaktierter Firma mit abgeschlossenem Beobachtungsfenster.**', '',
    '| Variante | Firmen zugeordnet | Anbieter angenommen | Kontaktiert belegt | Frist abgelaufen | Qualifiziert gebucht in Frist | Quote | Positive Antworten in Frist |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const v of report.variants) lines.push(`| ${text(v.id)} | ${v.assignedCompanies} | ${v.providerAccepted} | ${v.contactedCompanies} | ${v.matureCompanies} | ${v.qualifiedBookedWithinWindow} | ${v.primaryRate === null ? 'noch offen' : (v.primaryRate * 100).toFixed(1) + '%'} | ${v.positiveWithinWindow} |`);
  lines.push('', '## Betreffmethoden / ältere Vorlagen', '');
  for (const v of report.variants) lines.push(`- ${text(v.id)}: ${text(v.subjectMethod ?? v.subject)}`);
  lines.push('', 'Individuelle Bodies dürfen zwischen Firmen abweichen. Innerhalb einer Firma ändern die beiden Kandidaten nur den Betreff. Eine kleine Fallzahl ergibt keinen sicheren Sieger.', '',
    'Die Quote verlangt Buchungsbeleg plus dokumentierte Qualifikation (Bedarf, Ansprechpartner/Entscheidungsweg, Prüfer). Positive Antworten sind keine Buchungen. Absagen innerhalb des Fensters werden berücksichtigt. Ohne vollständiges Beobachtungsfenster bleibt die Quote offen.', '',
    '## Weitere Ergebnisse', '', '| Variante | Antworten | Buchungen (auch unqualifiziert) | Aktuell qualifiziert gebucht | Gehalten | Abgesagt | Negative Antwort | Workshop gewonnen |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const v of report.variants) lines.push(`| ${text(v.id)} | ${v.replies} | ${v.meetingsBooked} | ${v.qualifiedMeetingsBooked} | ${v.meetingsHeld} | ${v.meetingsCancelled} | ${v.negativeReplies} | ${v.workshopsWon} |`);
  lines.push('',
    'Öffnungen und Klicks sind Diagnosewerte und können durch automatische Abrufe entstehen. Annahme durch den Anbieter beweist keine Zustellung im Posteingang.', '',
    '## Technische Diagnose', '', '| Variante | Zugestellt laut Anbieter | Rückläufer | Öffnungen (unsicher) | Klicks (unsicher) | Unklare Versandversuche |', '| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const v of report.variants) lines.push(`| ${text(v.id)} | ${v.delivered} | ${v.bounced} | ${v.opensDiagnostic} | ${v.clicksDiagnostic} | ${v.unknownAttempts} |`);
  return lines.join('\n') + '\n';
}
