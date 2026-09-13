import { NextRequest, NextResponse } from 'next/server';
import { createLogin, revokeSession } from '@/lib/auth';
import { dashboardConfig, dashboardRequestAllowed, safeReturnPath } from '@/lib/runtime.mjs';
import { createLoginLimiter } from '@/lib/login-limit.mjs';

const allowAttempt = createLoginLimiter();

export async function POST(request: NextRequest) {
  let config;
  try { config = dashboardConfig(); }
  catch { return NextResponse.json({ error: 'Anmeldung nicht eingerichtet.' }, { status: 503 }); }
  if (!dashboardRequestAllowed(request.headers, config, true)) return NextResponse.json({ error: 'Fremder Ursprung abgewiesen.' }, { status: 403 });
  if (config.mode !== 'production') return NextResponse.redirect(new URL('/days', config.origin), 303);
  const fail = (next = '/days', limited = false) => {
    const url = new URL('/login', config.origin);
    url.searchParams.set('error', limited ? 'limit' : 'login');
    url.searchParams.set('next', safeReturnPath(next));
    return NextResponse.redirect(url, 303);
  };
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return fail();
  if (Number(request.headers.get('content-length') || 0) > 4096) return fail();
  const reader = request.body?.getReader();
  if (!reader) return fail();
  const chunks: Uint8Array[] = []; let length = 0;
  let form;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 4096) { await reader.cancel(); return fail(); }
      chunks.push(value);
    }
    form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  } catch { return fail(); }
  const email = (form.get('email') || '').trim().toLowerCase(), password = form.get('password') || '';
  const next = safeReturnPath(form.get('next'));
  if (form.getAll('email').length !== 1 || form.getAll('password').length !== 1
    || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 256) return fail(next);
  if (!allowAttempt(email)) return fail(next, true);
  try {
    const session = await createLogin(email, password);
    const expires = new Date(Math.min(session.expires.getTime(), Date.now() + 8 * 3600000));
    if (expires.getTime() <= Date.now()) { await revokeSession(session.secret); return fail(next); }
    const response = NextResponse.redirect(new URL(next, config.origin), 303);
    response.cookies.set(config.cookieName, session.secret, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires });
    return response;
  } catch { return fail(next); }
}
