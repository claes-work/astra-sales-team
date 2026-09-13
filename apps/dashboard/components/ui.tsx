import Link from 'next/link';
import { count, date, dayLabel, label } from '@/lib/format.mjs';
import { quizEvidence } from '@/lib/quiz.mjs';
import type { Row } from '@/lib/types';

export function PageHeader({ title, description, children }: { eyebrow?: string; title: string; description?: string; children?: React.ReactNode }) {
  return <header className="page-heading"><div><h1>{title}</h1>{description && <p className="lede">{description}</p>}</div>{children && <div className="heading-actions">{children}</div>}</header>;
}
export function Badge({ value, tone }: { value?: string; tone?: string }) {
  const chosen = tone || (['qualified', 'conversation_positive', 'reply_positive'].includes(value || '') ? 'green' : ['excluded', 'do_not_contact', 'blocked'].includes(value || '') ? 'red' : ['needs_review', 'sending', 'approved'].includes(value || '') ? 'amber' : 'neutral');
  return <span className={`badge ${chosen}`}>{label(value)}</span>;
}
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="empty"><h3>{title}</h3>{children && <p>{children}</p>}</div>;
}
export function DataError({ message }: { message: string }) {
  return <section className="error-box" role="alert"><h2>Daten nicht verfügbar</h2><p>{message}</p><a className="button secondary" href="">Erneut laden</a></section>;
}
export function Stat({ title, value, hint, primary }: { title: string; value: unknown; hint?: string; primary?: boolean }) {
  return <div className={`stat ${primary ? 'stat-primary' : ''}`}><dt>{title}{hint && <> <Info label={`Zählweise: ${title}`}>{hint}</Info></>}</dt><dd aria-label={typeof value === 'number' ? undefined : 'Nicht erfasst'}>{count(value)}</dd></div>;
}
export function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return <details className="info"><summary aria-label={label}><svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.2"/><path d="M10 9v5M10 6v.5" stroke="currentColor" strokeWidth="1.4"/></svg></summary><div className="info-content">{children}</div></details>;
}
export function Disclosure({ title, children, meta }: { title: string; children: React.ReactNode; meta?: React.ReactNode }) {
  return <details className="disclosure"><summary><span>{title}</span>{meta && <span className="muted small">{meta}</span>}<span className="disclosure-chevron" aria-hidden="true">⌄</span></summary><div className="disclosure-body">{children}</div></details>;
}
function RecordedDayCount({ value }: { value: unknown }) {
  const note = value == null ? '0 erfasst; für diesen Tag liegt keine Messung vor.' : undefined;
  return <span title={note} aria-label={note}>{count(value ?? 0)}</span>;
}
export function DaysTable({ days, compact = false }: { days: Row[]; compact?: boolean }) {
  if (!days.length) return <Empty title="Noch keine Aktivitäten erfasst"/>;
  return <div className="table-scroll"><table className="days-table"><thead><tr><th>Tag</th><th className="numeric">Kandidaten</th><th className="numeric">Qualifiziert</th><th className="numeric">Versendet</th>{!compact && <th className="numeric">Zugestellt</th>}<th><span className="sr-only">Tag öffnen</span></th></tr></thead><tbody>{days.map(d => <tr key={d.day}><td><Link href={`/days/${d.day}`} className="row-link">{dayLabel(d.day)}</Link></td><td className="numeric"><RecordedDayCount value={d.consideredCandidates ?? d.searchedCandidates}/></td><td className="numeric"><RecordedDayCount value={d.qualifiedCandidates}/></td><td className="numeric strong"><RecordedDayCount value={d.sentMessages}/></td>{!compact && <td className="numeric"><RecordedDayCount value={d.deliveredMessages}/></td>}<td className="row-end"><Link href={`/days/${d.day}`} aria-label={`Tag ${dayLabel(d.day)} öffnen`}>↗</Link></td></tr>)}</tbody></table></div>;
}
export function Timeline({ items }: { items: Row[] }) {
  if (!items.length) return <Empty title="Noch keine Ereignisse erfasst"/>;
  const sorted = [...items].sort((a, b) => (Date.parse(a.at || a.occurredAt || a.occurred_at) - Date.parse(b.at || b.occurredAt || b.occurred_at)) || String(a.id || a.$id).localeCompare(String(b.id || b.$id)));
  return <ol className="timeline">{sorted.map((event, index) => {
    let detail = event.details || {}; if (event.details_json) { try { detail = JSON.parse(event.details_json); } catch { /* Incomplete historical details remain unavailable. */ } }
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) detail = {};
    const note = event.note || detail.note;
    const quiz = quizEvidence(event);
    const eventType = event.type || event.event_type;
    const title = eventType === 'quiz_completed' ? quiz ? 'Quiz ausgefüllt' : 'Quizereignis ohne Abschlussbeleg' : label(eventType);
    return <li key={event.id || event.$id || index}><div className="timeline-dot"/><div className="timeline-body"><div className="timeline-title"><strong>{title}{quiz?.is_test && <span className="badge amber quiz-test">Test</span>}</strong><time>{date(event.at || event.occurredAt || event.occurred_at, true)}</time></div><p className="muted small">Quelle: {quiz ? 'Roadmap-Quiz' : label(event.channel || detail.channel || event.source || detail.source)}{(event.by || detail.by) && ` · erfasst von ${event.by || detail.by}`}</p>{note && <p className="preserve">{note}</p>}{quiz && <div className="quiz-contact"><h3>Kontakt aus dem Quizformular</h3><p className="muted small">Abgesendet am {date(quiz.contact.captured_at, true)}</p><DetailList items={[
      ['Name', `${quiz.contact.first_name} ${quiz.contact.last_name}`], ['E-Mail', quiz.contact.email], ['Firma', quiz.contact.company],
      ...(quiz.contact.phone ? [['Telefon', quiz.contact.phone] as [string, React.ReactNode]] : []), ['Ergebnis', `Stufe ${quiz.result.stage}`],
    ]}/></div>}{detail.booking?.evidence && <p>{detail.booking.evidence}</p>}{(event.messageId || event.message_id) && <Link className="small" href={`/messages/${event.messageId || event.message_id}`}>Zugeordnete Mail ansehen ↗</Link>}</div></li>;
  })}</ol>;
}
export function DetailList({ items }: { items: [string, React.ReactNode][] }) {
  return <dl className="detail-list">{items.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value || 'Unbekannt'}</dd></div>)}</dl>;
}
