import { NextRequest, NextResponse } from 'next/server';
import { dashboardConfig, dashboardRequestAllowed } from './lib/runtime.mjs';

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === '/api/health' && ['GET', 'HEAD'].includes(request.method)) return NextResponse.next();
  let config;
  try { config = dashboardConfig(); }
  catch { return new NextResponse('Dashboard nicht eingerichtet.', { status: 503 }); }
  if (!dashboardRequestAllowed(request.headers, config, !['GET', 'HEAD'].includes(request.method))) {
    return new NextResponse('Fremder Ursprung abgewiesen.', { status: 403 });
  }
  const publicPath = ['/login', '/api/auth/login', '/api/auth/logout'].includes(request.nextUrl.pathname);
  if (config.mode === 'production' && !publicPath && !request.cookies.get(config.cookieName)?.value) {
    if (request.nextUrl.pathname.startsWith('/api/')) return NextResponse.json({ error: 'Bitte anmelden.' }, { status: 401 });
    const login = new URL('/login', config.origin);
    login.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
