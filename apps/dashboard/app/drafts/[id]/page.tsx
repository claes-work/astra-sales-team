import Link from 'next/link';
import { notFound } from 'next/navigation';
import { load } from '@/lib/api';
import { validId } from '@/lib/input.mjs';
import { label } from '@/lib/format.mjs';
import type { Row } from '@/lib/types';
import { PageHeader, DataError, Badge, DetailList, Disclosure } from '@/components/ui';

export const metadata = { title: 'Mailentwurf' };
export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; if (!validId(id)) notFound();
  const result = await load<Row>(`/v1/drafts/${id}`);
  if (result.error) return <><PageHeader eyebrow="Arbeitsfassung" title="Individueller Entwurf"/><DataError message={result.error}/></>;
  const draft = result.data!;
  const definition = draft.definition || {};
  if (draft.kind !== 'personalization') notFound();
  return <><Link href="/leads" className="back-link">← Leads</Link><PageHeader title="Mailentwurf" description={definition.recipientName || definition.title || draft.key}><Badge value="draft"/></PageHeader><p className="notice warning">Arbeitsfassung · nicht versendet. Ein Inhaltsreview ist keine Versandfreigabe.</p>
    <section className="section"><div className="section-heading"><h2>Betreffvarianten</h2><span className="small muted">Entwurfsversion {draft.version}</span></div><div className="section-body"><DetailList items={Object.entries(definition.subjects || {}).map(([variant, value]) => [`Variante ${variant.toUpperCase()}`, typeof value === 'string' ? value : (value as Row)?.text || 'Nicht hinterlegt'])}/></div><pre className="mail-content">{definition.body || 'Kein Text hinterlegt.'}</pre></section>
    <Disclosure title="Review & Version"><DetailList items={[
      ['Empfängername', definition.recipientName || 'Noch nicht angegeben'], ['Inhaltsreview', definition.review?.status ? label(definition.review.status) : 'Nicht hinterlegt'], ['Geprüft von', definition.review?.by || definition.review?.reviewedBy || definition.review?.reviewer || 'Nicht hinterlegt'], ['Version', String(draft.version)],
    ]}/></Disclosure><Disclosure title="Referenzen zur Arbeitsfassung"><DetailList items={[
      ['Entwurfskennung', <span className="reference">{draft.id}</span>], ['Inhaltsprüfsumme', <span className="reference">{draft.contentHash}</span>], ['Bewertung', <span className="reference">{definition.assessmentId}</span>],
    ]}/></Disclosure>
  </>;
}
