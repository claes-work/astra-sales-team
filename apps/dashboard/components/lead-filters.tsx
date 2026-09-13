'use client';
import Link from 'next/link';
import { useState } from 'react';
import { activeFilters, filterResetUrl } from '@/lib/presentation.mjs';

export function LeadFilters({ query }: { query: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const active = activeFilters(query);
  return <form className="lead-search" action="/leads" role="search"><div className="search-toolbar">
    <div className="search-input"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input name="q" type="search" defaultValue={query.q} placeholder="Firma suchen …" aria-label="Firma suchen" maxLength={200}/><button className="search-submit" type="submit" aria-label="Suchen">↵</button></div>
    <button type="button" className={`filter-button secondary ${open ? 'selected' : ''}`} aria-expanded={open} aria-controls="lead-filter-panel" onClick={() => setOpen(!open)}><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="1.5" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="currentColor"/><circle cx="15" cy="17" r="2" fill="currentColor"/></svg>Filter{active > 0 && <span className="filter-count">{active}</span>}</button>
    {active > 0 && <Link className="reset-filters" href={filterResetUrl(query)}>Zurücksetzen</Link>}
  </div><div id="lead-filter-panel" className="filter-panel" hidden={!open}><div className="filter-grid">
    <label className="field"><span>Eignung</span><select name="fit" defaultValue={query.fit}><option value="">Alle</option><option value="qualified">Passend</option><option value="needs_review">Prüfung offen</option><option value="excluded">Ausgeschlossen</option><option value="not_qualified">Nicht passend</option><option value="unreviewed">Ungeprüft</option></select></label>
    <label className="field"><span>Ansprache</span><select name="outreach" defaultValue={query.outreach}><option value="">Alle</option><option value="sent">Versendet</option><option value="draft">Mit Entwurf</option><option value="accepted">Anbieter angenommen</option><option value="unsent">Nicht angeschrieben</option></select></label>
    <label className="field"><span>Kontaktsperre</span><select name="blocked" defaultValue={query.blocked}><option value="">Alle</option><option value="true">Gesperrt</option><option value="false">Ohne Sperre</option></select></label>
    <label className="field"><span>Rückmeldung</span><select name="positive" defaultValue={query.positive}><option value="">Alle</option><option value="true">Positiv</option></select></label>
    <label className="field"><span>Recherche</span><select name="research" defaultValue={query.research}><option value="">Alle</option><option value="unreviewed">Ungeprüft</option><option value="reviewed">Geprüft</option><option value="enriched">Angereichert</option></select></label>
    <label className="field"><span>Sortierung</span><select name="sort" defaultValue={query.sort}><option value="name_asc">Name A–Z</option><option value="name_desc">Name Z–A</option><option value="research_desc">Zuletzt geprüft</option><option value="created_desc">Zuletzt aufgenommen</option></select></label>
  </div><div className="filter-footer"><label className="inline-field"><span>Pro Seite</span><select name="pageSize" defaultValue={query.pageSize}>{['10','20','50','100'].map(n => <option value={n} key={n}>{n}</option>)}</select></label><button type="submit">Anwenden</button></div></div></form>;
}
