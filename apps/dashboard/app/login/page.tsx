import { redirect } from 'next/navigation';
import { dashboardConfig, safeReturnPath } from '@/lib/runtime.mjs';

export const metadata = { title: 'Anmelden' };
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const config = dashboardConfig();
  if (config.mode === 'local') redirect('/days');
  const params = await searchParams;
  const error = params.error === 'limit' ? 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.' : params.error ? 'Anmeldung nicht möglich. Bitte Zugangsdaten prüfen und erneut versuchen.' : null;
  return <section className="login-card"><p className="login-brand">Sales</p><h1>Anmelden</h1><p className="muted login-intro">Dein Vertriebsdashboard</p>{error && <p className="login-error" role="alert">{error}</p>}
    <form action="/api/auth/login" method="post"><input type="hidden" name="next" value={safeReturnPath(params.next)}/>
      <label className="field"><span>E-Mail</span><input type="email" name="email" autoComplete="username" required maxLength={254}/></label>
      <label className="field"><span>Passwort</span><input type="password" name="password" autoComplete="current-password" required minLength={8} maxLength={256}/></label>
      <button type="submit">Anmelden</button>
    </form></section>;
}
