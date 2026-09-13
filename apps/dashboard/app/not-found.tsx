import Link from 'next/link';
export default function NotFound() { return <section className="empty"><h1>Eintrag nicht gefunden</h1><p>Dieser Link ist ungültig oder der Eintrag ist nicht mehr vorhanden.</p><Link href="/leads" className="button">Zur Lead-Liste</Link></section>; }
