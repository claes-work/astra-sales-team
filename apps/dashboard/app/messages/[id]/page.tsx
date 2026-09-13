import Link from 'next/link';
import { notFound } from 'next/navigation';
import { load } from '@/lib/api';
import { date, sentTime } from '@/lib/format.mjs';
import { validId } from '@/lib/input.mjs';
import type { MessageDetail } from '@/lib/types';
import { PageHeader, DataError, Badge, DetailList, Timeline, Disclosure, Info } from '@/components/ui';

export const metadata = { title: 'E-Mail' };
export default async function MessagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; if (!validId(id)) notFound();
  const result = await load<MessageDetail>(`/v1/dashboard/messages/${id}`);
  if (result.error) return <><PageHeader eyebrow="Mail" title="Nachricht"/><DataError message={result.error}/></>;
  const mail = result.data!;
  const sent = Boolean(mail.sentAt);
  const submitted = Boolean(mail.acceptedAt || mail.status === 'sending');
  const sender = typeof mail.sender === 'string' ? mail.sender : [mail.sender?.name, mail.sender?.email].filter(Boolean).join(' · ');
  return <><Link href={`/leads/${mail.companyId}`} className="back-link">← {mail.companyName}</Link><PageHeader eyebrow={sent ? 'Mailhistorie' : submitted ? 'Anbieterauftrag' : 'Aktuelle Nachrichtenfassung'} title={sent ? 'Versendete E-Mail' : submitted ? 'Versand noch nicht belegt' : 'Mailentwurf'} description={mail.companyName}><Badge value={sent ? 'sent' : submitted ? 'accepted' : mail.status}/></PageHeader>
    {!mail.snapshotVerified && <p className="notice warning">Die gespeicherte Fassung konnte nicht vollständig gegen den eingefrorenen Inhalt geprüft werden. Die Anzeige ist kein verifizierter Versandbeleg.</p>}
    {!sent && <p className="notice">{submitted ? 'Anbieterauftrag erfasst. Versand noch nicht belegt.' : 'Aktuelle Arbeitsfassung · nicht versendet.'}</p>}
    <div className="two-column"><section className="section"><div className="section-heading"><h2 className="mail-subject">{mail.subject || '(Ohne Betreff)'}</h2></div><div className="section-body"><DetailList items={[
      ['An', mail.to], ['Von', sender], ['Antwort an', mail.replyTo], ['Versand belegt', sentTime(mail)], ['Anbieter angenommen', mail.acceptedAt ? date(mail.acceptedAt, true) : 'Nicht erfasst'],
    ]}/></div><pre className="mail-content">{mail.body || 'Kein Mailtext gespeichert.'}</pre><div className="section-foot">{mail.snapshotVerified ? 'Eingefrorene Fassung · Inhalt geprüft' : 'Gespeicherte Fassung · Prüfung unvollständig'}</div></section><section className="section"><div className="section-heading"><h2>Ereignisverlauf</h2><Info label="Aussagekraft der Ereignisse">Öffnungen und Klicks sind Anbietersignale. Automatische Abrufe sind möglich; sie belegen weder einen Menschen noch den Posteingang.</Info></div><div className="section-body"><Timeline items={mail.timeline}/></div></section></div>
    <Disclosure title="Messung & Zuordnung"><DetailList items={[
      ['Zustellung', mail.deliveredAt ? `${date(mail.deliveredAt, true)} · gemeldet` : 'Kein Ereignis erfasst'],
      ['Quiz / Buchung', 'Zugeordnete Abschlüsse und belegte Buchungen im Ereignisverlauf'], ['Öffnungen / Klicks', 'Nur vorhandene Ereignisse im Verlauf; fehlende Ereignisse bleiben unbekannt'],
    ]}/><p className="data-note">Buchungen und Qualifikationen erscheinen im Verlauf, wenn sie belegt und dieser Mail zugeordnet sind.</p></Disclosure>
    <Disclosure title="Referenzen zur Fassung"><DetailList items={[
      ['Nachricht', <span className="reference">{mail.id}</span>],
      ['Experiment', <span className="reference">{mail.frozen?.experimentId || 'Nicht hinterlegt'}</span>],
      ['Variante', mail.frozen?.variant || 'Nicht hinterlegt'],
      ['Inhaltsprüfsumme', <span className="reference">{mail.frozen?.contentHash || 'Nicht hinterlegt'}</span>],
      ['Strategie', mail.frozen?.strategy ? `${mail.frozen.strategy.key} · ${mail.frozen.strategy.version}` : 'Keine individuelle Strategieversion hinterlegt'],
      ['Mailversion', mail.frozen?.personalizationVersion || 'Nicht hinterlegt'],
      ['Experimentversion', mail.frozen?.experiment ? <span className="reference">{mail.frozen.experiment.id || mail.frozen.experiment.key} · {mail.frozen.experiment.version}</span> : 'Nicht hinterlegt'],
    ]}/></Disclosure>
  </>;
}
