import { NextRequest, NextResponse } from 'next/server';
import { revokeSession } from '@/lib/auth';
import { dashboardConfig, dashboardRequestAllowed } from '@/lib/runtime.mjs';

export async function POST(request: NextRequest) {
  let config;
  try { config = dashboardConfig(); }
  catch { return NextResponse.json({ error: 'Abmeldung nicht verfügbar.' }, { status: 503 }); }
  if (!dashboardRequestAllowed(request.headers, config, true)) return NextResponse.json({ error: 'Fremder Ursprung abgewiesen.' }, { status: 403 });
  const secret = request.cookies.get(config.cookieName)?.value;
  if (config.mode === 'production' && secret) {
    try { await revokeSession(secret); }
    catch { return NextResponse.json({ error: 'Abmeldung konnte nicht bestätigt werden. Bitte erneut versuchen.' }, { status: 503 }); }
  }
  const response = NextResponse.redirect(new URL(config.mode === 'production' ? '/login' : '/days', config.origin), 303);
  response.cookies.set(config.cookieName, '', { httpOnly: true, secure: config.mode === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
  return response;
}
