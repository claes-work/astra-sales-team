import { NextRequest, NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';
import { activityInput } from '@/lib/input.mjs';
import { dashboardConfig, dashboardRequestAllowed } from '@/lib/runtime.mjs';
import { requireUser, AuthenticationError } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    if (!dashboardRequestAllowed(request.headers, dashboardConfig(), true)) return NextResponse.json({ error: 'Fremder Ursprung abgewiesen.' }, { status: 403 });
    await requireUser();
  } catch (error) { return NextResponse.json({ error: 'Zugriff nicht möglich.' }, { status: error instanceof AuthenticationError ? error.status : 503 }); }
  if (!request.headers.get('content-type')?.startsWith('application/json')) return NextResponse.json({ error: 'JSON-Inhalt erforderlich.' }, { status: 415 });
  const reader = request.body?.getReader();
  if (!reader) return NextResponse.json({ error: 'Eingabe fehlt.' }, { status: 400 });
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16384) { await reader.cancel(); return NextResponse.json({ error: 'Die Eingabe ist zu groß.' }, { status: 413 }); } chunks.push(value); }
    let input;
    try { input = activityInput(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (error) { return NextResponse.json({ error: error instanceof SyntaxError ? 'Ungültiger JSON-Inhalt.' : error instanceof Error ? error.message : 'Ungültige Eingabe.' }, { status: 400 }); }
    await api('/v1/lead-activities', input);
    return NextResponse.json({ saved: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof ApiError ? error.message : 'Die Speicherung konnte nicht bestätigt werden. Bitte erneut versuchen.' }, { status: error instanceof ApiError || error instanceof AuthenticationError ? error.status : 503 });
  }
}
