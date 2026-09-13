import 'server-only';
import path from 'node:path';
import { redirect } from 'next/navigation';
import { dashboardConfig } from './runtime.mjs';
import { requireUser, AuthenticationError } from './auth';
import { serverSecret } from './secrets';

export class ApiError extends Error {
  constructor(message: string, public status = 503) { super(message); }
}
export async function api<T>(route: string, body?: unknown): Promise<T> {
  await requireUser();
  const config = dashboardConfig();
  const readable = /^\/v1\/dashboard(?:\/|$)/.test(route) || /^\/v1\/drafts\/[\w-]+(?:\/preview)?$/.test(route);
  if (body === undefined ? !readable : route !== '/v1/lead-activities') throw new ApiError('Dieser Datenweg ist nicht freigegeben.', 400);
  const token = await serverSecret('SALES_API_TOKEN', config.mode === 'local' ? path.resolve(process.cwd(), '../../.local/outreach/api-token.txt') : undefined);
  let response: Response;
  try {
    response = await fetch(`${config.apiUrl}${route}`, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new ApiError('Die Vertriebsdaten sind vorübergehend nicht erreichbar. Bitte erneut versuchen.'); }
  let data;
  try { data = await response.json(); } catch { throw new ApiError('Die API hat keine lesbare Antwort geliefert.'); }
  if (!response.ok) {
    if (response.status === 400 && body !== undefined) throw new ApiError(typeof data.error === 'string' ? data.error : 'Die Rückmeldung wurde abgewiesen.', 400);
    if (response.status === 404) throw new ApiError('Dieser Eintrag oder Datenweg wurde nicht gefunden.', 404);
    throw new ApiError('Die Vertriebsdaten konnten nicht geladen werden. Bitte erneut versuchen.', response.status);
  }
  return data as T;
}
export async function load<T>(route: string): Promise<{ data: T; error?: never } | { data?: never; error: string }> {
  try { return { data: await api<T>(route) }; }
  catch (error) {
    if (error instanceof AuthenticationError && [401, 403].includes(error.status)) redirect('/login');
    return { error: error instanceof ApiError ? error.message : 'Die Daten konnten nicht geladen werden.' };
  }
}
