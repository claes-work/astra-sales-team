import Link from 'next/link';
import { notFound } from 'next/navigation';
import { load } from '@/lib/api';
import { date, safeWebsite, sentTime, researchLabel } from '@/lib/format.mjs';
import { validId } from '@/lib/input.mjs';
import { conciseReason } from '@/lib/presentation.mjs';
import type { LeadDetail } from '@/lib/types';
import { LeadActions } from '@/components/lead-actions';
import { PageHeader, DataError, Badge, DetailList, Timeline, Disclosure } from '@/components/ui';

export const metadata = { title: 'Lead-Details' };
export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; if (!validId(id)) notFound();
  const result = await load<LeadDetail>(`/v1/dashboard/leads/${id}`);
  if (result.error) return <><PageHeader title="Unternehmen"/><DataError message={result.error}/></>;
  const { company, contacts, assessments, messages, activities, drafts, quizSubmissions = [] } = result.data!;
  if (!company) notFound();
  const website = safeWebsite(company.website);
  const historical = messages.filter(m => m.sentAt || m.acceptedAt || m.status === 'sending');
  const currentDrafts = messages.filter(m => !historical.includes(m));
  return <><Link href="/leads" className="back-link">← Leads</Link><PageHeader title={company.name} description={company.domain}><div className="inline-badges"><Badge value={company.fit}/>{company.blocked && <Badge value="blocked"/>}</div></PageHeader>
    <LeadActions companyId={company.$id} companyName={company.name} blocked={Boolean(company.do_not_contact)} messages={messages}/>
    {company.blocked && <p className="notice error"><strong>{company.do_not_contact ? 'Kontakt gesperrt.' : 'Ein Ansprechpartner ist gesperrt.'}</strong> {company.blockReason}</p>}
    <div className="two-column"><div><section className="section"><div className="section-heading"><h2>Rückmeldungen</h2></div>{activities.length ? <Timeline items={activities}/> : <p className="muted small">Noch keine Rückmeldung erfasst.</p>}</section>
      {quizSubmissions.length > 0 && <section className="section"><div className="section-heading"><h2>Quiz-Abschlüsse</h2></div><Timeline items={quizSubmissions}/></section>}
      <section className="section"><div className="section-heading"><h2>E-Mails</h2><span className="small muted">{historical.length}</span></div>{!historical.length ? <p className="muted small">Noch keine E-Mail im Verlauf.</p> : <ul className="plain-list">{historical.map(mail => <li key={mail.id}><Link className="row-link" href={`/messages/${mail.id}`}>{mail.subject || '(Ohne Betreff)'}</Link><p>{sentTime(mail)}{!mail.sentAt && <> · <Badge value={mail.acceptedAt ? 'accepted' : 'sending'}/></>}</p></li>)}</ul>}</section>
      <section className="section"><div className="section-heading"><h2>Entwürfe</h2></div>{!currentDrafts.length && !drafts?.length ? <p className="muted small">Keine Entwürfe vorhanden.</p> : <ul className="plain-list">{currentDrafts.map(mail => <li key={mail.id}><Link href={`/messages/${mail.id}`} className="row-link">{mail.subject || '(Ohne Betreff)'}</Link><Badge value={mail.status}/></li>)}{drafts?.map(draft => <li key={draft.id || draft.$id}><Link href={`/drafts/${draft.id || draft.$id}`} className="row-link">{draft.title || draft.name || 'Individueller Entwurf'}</Link><Badge value="draft"/></li>)}</ul>}</section>
    </div><section className="section"><div className="section-heading"><h2>Kontakt</h2></div>{!contacts.length ? <p className="small muted">Noch kein Kontakt gespeichert.</p> : contacts.map(contact => <div className="contact" key={contact.$id}><h3>{contact.name || 'Name unbekannt'}</h3>{contact.role && <p className="muted">{contact.role}</p>}<p>{contact.email || 'E-Mail fehlt'}</p>{contact.phone && <p>{contact.phone}</p>}{contact.do_not_contact && <p><Badge value="blocked"/></p>}</div>)}{website && <p style={{marginTop:20}}><a className="text-link" href={website} target="_blank" rel="noreferrer">{company.domain || 'Website'} ↗</a></p>}</section></div>
    <Disclosure title="Recherche & Bewertung"><DetailList items={[
      ['Eignung', <Badge value={company.fit}/>], ['Begründung', conciseReason(company.reason)], ['Recherche', researchLabel(company.researchStatus)], ['Stichtag', date(company.lastResearchAt)], ['Aufgenommen', date(company.createdAt,true)],
    ]}/>{assessments.length > 0 && <Disclosure title="Frühere Bewertungen"><ul className="plain-list">{assessments.map(a => <li key={a.$id}><Badge value={a.status}/><span className="small muted"> · {date(a.$createdAt,true)}</span><p>{conciseReason(a.reason)}</p><span className="reference">ICP: {a.icp_version_id}</span></li>)}</ul></Disclosure>}</Disclosure>
  </>;
}
