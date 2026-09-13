import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Overview, Row } from '@/lib/types';
import { PageHeader, DataError, DaysTable, Info, Stat } from '@/components/ui';
import { quizCount } from '@/lib/quiz.mjs';
export const metadata: Metadata = { title: 'Tage' };
export default async function DaysPage() {
  const [days, overview] = await Promise.all([
    load<{ timezone: string; items: Row[] }>('/v1/dashboard/days'),
    load<Overview>('/v1/dashboard/overview'),
  ]);
  const success = overview.data?.success;
  return <>
    <PageHeader title="Tage"><span className="small muted">Berlin</span><Info label="Tageszuordnung"><p>Die Tageszeile verbindet die zugeordnete Recherche mit dem Versand. Jede Firma zählt einmal als Kandidat. Erneute Regelprüfungen erhöhen diese Zahl nicht.</p><p>Der Pilot ist dem 12. September zugeordnet; die Recherche vom 10. September bleibt im Tagesdetail nachvollziehbar. Ohne eigenen Versandzeitpunkt zählt die belegte Zustellung am Zustelltag.</p></Info></PageHeader>
    <p className="stats-scope small muted">Gesamt</p>
    {overview.error ? <DataError message={overview.error}/> : <dl className="stats days-summary" aria-label="Gesamtzahlen">
      <Stat title="E-Mails versendet" value={success?.sentMessages?.value ?? overview.data?.totals.sentMessages}/>
      <Stat title="E-Mails geöffnet" value={success?.openedMessages?.value ?? success?.openedMessages?.recordedCount ?? 0}/>
      <Stat title="Link geklickt" value={success?.clickedMessages?.value ?? success?.clickedMessages?.recordedCount ?? 0}/>
      <Stat title="Quiz ausgefüllt" value={quizCount(success?.completedQuizzes)}/>
      <Stat title="Termin gebucht" value={success?.confirmedMeetings?.value ?? success?.confirmedMeetings?.recordedCount ?? 0}/>
    </dl>}
    {days.error ? <DataError message={days.error}/> : <DaysTable days={days.data!.items}/>}
  </>;
}
