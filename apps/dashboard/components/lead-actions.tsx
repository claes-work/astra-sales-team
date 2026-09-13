'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { date, localMinute } from '@/lib/format.mjs';
import type { Row } from '@/lib/types';

export function LeadActions({ companyId, companyName, blocked, messages }: { companyId: string; companyName: string; blocked: boolean; messages: Row[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<'feedback' | 'block' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [time, setTime] = useState('');
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (mode) panel.current?.querySelector<HTMLElement>('select, input')?.focus(); else if (trigger.current?.isConnected) trigger.current.focus(); }, [mode]);
  const open = (next: 'feedback' | 'block', button: HTMLButtonElement) => { trigger.current = button; setMode(next); setError(''); setSuccess(''); setSourceId(crypto.randomUUID()); setTime(localMinute()); };
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true); setError('');
    const input = { companyId, sourceId, type: mode === 'block' ? 'do_not_contact' : String(form.get('type')), channel: String(form.get('channel')), localTime: String(form.get('localTime')), offset: String(form.get('offset')), note: String(form.get('note')), by: String(form.get('by')), ...(form.get('messageId') ? { messageId: String(form.get('messageId')) } : {}) };
    try {
      const response = await fetch('/api/activities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Die Änderung konnte nicht gespeichert werden.');
      setMode(null); setSuccess(mode === 'block' ? 'Kontaktsperre gespeichert. Das Unternehmen ist für weitere Ansprache gesperrt.' : 'Rückmeldung gespeichert. Sie ist jetzt im Verlauf sichtbar.');
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Die Änderung konnte nicht bestätigt werden. Bitte erneut versuchen.'); }
    finally { setPending(false); }
  }
  return <><div className="heading-actions"><button type="button" onClick={e => open('feedback', e.currentTarget)} disabled={pending}>Rückmeldung erfassen</button>{!blocked && <button type="button" className="secondary" onClick={e => open('block', e.currentTarget)} disabled={pending}>Kontakt sperren</button>}</div>
    {success && <p className="notice" role="status">{success}</p>}
    {mode && <section ref={panel} className="action-panel" aria-labelledby="action-title" onKeyDown={e => { if (e.key === 'Escape' && !pending) { e.stopPropagation(); setMode(null); } }}><div className="action-panel-header"><h2 id="action-title">{mode === 'block' ? 'Kontakt sperren' : 'Rückmeldung erfassen'}</h2><button className="action-close" type="button" onClick={() => setMode(null)} disabled={pending} aria-label="Formular schließen">×</button></div>
      {mode === 'block' && <p className="notice warning" style={{ marginTop: 0, marginBottom: 20 }}>Verhindert weitere Ansprache des gesamten Unternehmens.</p>}
      <form onSubmit={submit}><div className="form-grid">{mode === 'feedback' && <label className="field"><span>Ergebnis</span><select name="type" required><option value="conversation_positive">Positive Rückmeldung</option><option value="note">Notiz / sonstige Rückmeldung</option></select></label>}
        <label className="field"><span>Quelle</span><select name="channel" required><option value="phone">Telefon</option><option value="email">E-Mail</option><option value="other">Manuell / sonstige Quelle</option></select></label>
        <label className="field"><span>Wann? · Berliner Ortszeit</span><input type="datetime-local" name="localTime" value={time} onChange={e => setTime(e.target.value)} required/></label>
        <label className="field"><span>Erfasst von</span><input name="by" placeholder="Dein Name" maxLength={120} required autoComplete="name"/></label>
        <label className="field wide"><span>{mode === 'block' ? 'Grund der Sperre' : 'Kurze Notiz'}</span><textarea name="note" placeholder={mode === 'block' ? 'Zum Beispiel: Am Telefon um keine weitere Kontaktaufnahme gebeten.' : 'Was wurde gesagt oder vereinbart?'} maxLength={4000} required/></label>
        <label className="field"><span>Mailbezug (optional)</span><select name="messageId"><option value="">Ohne konkrete Mailzuordnung</option>{messages.filter(m => m.sentAt || m.acceptedAt).map(m => <option key={m.id} value={m.id}>{date(m.sentAt || m.acceptedAt)} · {m.subject || '(Ohne Betreff)'}</option>)}</select></label>
        <label className="field"><span>Zeitumstellung</span><select name="offset" defaultValue="auto"><option value="auto">Zeitversatz automatisch</option><option value="+02:00">Sommerzeit (UTC+2)</option><option value="+01:00">Winterzeit (UTC+1)</option></select></label>
      </div>{error && <p className="notice error" role="alert">{error}</p>}<div className="form-actions"><button className="secondary" type="button" onClick={() => setMode(null)} disabled={pending}>Abbrechen</button><button className={mode === 'block' ? 'danger' : ''} disabled={pending} type="submit">{pending ? 'Wird gespeichert …' : mode === 'block' ? 'Sperre speichern' : 'Rückmeldung speichern'}</button></div></form>
    </section>}
  </>;
}
