import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { count } from '@/lib/format.mjs';
import { leadQuery } from '@/lib/input.mjs';
import type { LeadPage } from '@/lib/types';
import { PageHeader, DataError, Badge, Empty } from '@/components/ui';
import { LeadFilters } from '@/components/lead-filters';

export const metadata: Metadata = { title: 'Leads' };
type Params = Record<string, string | string[] | undefined>;
export default async function LeadsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const query = leadQuery(await searchParams);
  const result = await load<LeadPage>(`/v1/dashboard/leads?${new URLSearchParams(query)}`);
  const data = result.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const pageLink = (page: number) => `/leads?${new URLSearchParams({ ...query, page: String(page) })}`;
  return <>
    <PageHeader title="Leads">{data && <span className="muted">{count(data.total)} Unternehmen</span>}</PageHeader>
    <LeadFilters key={new URLSearchParams(query).toString()} query={query}/>
    {result.error ? <DataError message={result.error}/> : !data?.items.length ? <Empty title={data?.total ? 'Diese Seite ist leer' : query.q || query.fit || query.outreach || query.blocked || query.positive || query.research ? 'Keine passenden Leads' : 'Noch keine Leads'}><Link href="/leads">Alle Leads anzeigen</Link></Empty> : <div className="table-scroll" tabIndex={0} role="region" aria-label="Lead-Liste"><table className="leads-table"><thead><tr><th>Unternehmen</th><th>Eignung</th><th>Ansprache</th><th>Rückmeldung</th><th><span className="sr-only">Öffnen</span></th></tr></thead><tbody>{data.items.map(lead => <tr key={lead.$id}>
      <td><Link className="row-link" href={`/leads/${lead.$id}`}>{lead.name}</Link><span className="row-sub">{lead.domain || 'Domain fehlt'}{lead.blocked && <span className="inline-blocked"><Badge value="blocked"/></span>}</span></td>
      <td><Badge value={lead.fit}/></td>
      <td><span className={lead.outreachStatus === 'unsent' ? 'muted' : ''}>{lead.outreachStatus === 'sent' ? 'Versendet' : lead.outreachStatus === 'accepted' ? 'Anbieter angenommen' : lead.outreachStatus === 'draft' ? 'Entwurf' : lead.outreachStatus === 'unsent' ? 'Noch nicht kontaktiert' : 'Status unbekannt'}</span></td>
      <td>{lead.positiveResponse ? <span className="positive-text">Positiv</span> : <span className="muted" aria-label="Keine positive Rückmeldung erfasst">—</span>}</td>
      <td className="row-end"><Link href={`/leads/${lead.$id}`} aria-label={`${lead.name} öffnen`}>→</Link></td>
    </tr>)}</tbody></table></div>}
    {data && <div className="pagination"><span>{data.total && data.items.length ? `${count((data.page - 1) * data.pageSize + 1)}–${count((data.page - 1) * data.pageSize + data.items.length)} von ${count(data.total)}` : `${count(data.total)} Unternehmen`}</span><div className="pagination-links">{data.page > 1 ? <Link href={pageLink(data.page - 1)} aria-label="Vorherige Seite">←</Link> : <span className="disabled" aria-hidden="true">←</span>}<span>{count(data.page)} / {count(pages)}</span>{data.page < pages ? <Link href={pageLink(data.page + 1)} aria-label="Nächste Seite">→</Link> : <span className="disabled" aria-hidden="true">→</span>}</div></div>}
  </>;
}
