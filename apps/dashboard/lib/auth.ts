import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { Client, Account } from 'node-appwrite';
import { dashboardConfig, authorizedAccount } from './runtime.mjs';
import { serverSecret } from './secrets';

export class AuthenticationError extends Error {
  constructor(public status = 401) { super(status === 503 ? 'Anmeldung vorübergehend nicht verfügbar.' : status === 403 ? 'Kein Zugriff auf dieses Dashboard.' : 'Bitte anmelden.'); }
}

class DashboardClient extends Client {
  override prepareRequest(...args: Parameters<Client['prepareRequest']>) {
    const request = super.prepareRequest(...args);
    request.options.signal = AbortSignal.timeout(15000);
    request.options.redirect = 'error';
    return request;
  }
}

function sessionAccount(secret: string) {
  const config = dashboardConfig();
  if (config.mode !== 'production' || !config.appwriteEndpoint || !config.projectId) throw new AuthenticationError();
  return new Account(new DashboardClient().setEndpoint(config.appwriteEndpoint).setProject(config.projectId).setSession(secret));
}

export async function validateSession(secret: string | undefined) {
  const config = dashboardConfig();
  if (config.mode === 'local') return { id: 'local-operator', name: 'Lokaler Betreiber' };
  if (!secret || secret.length > 4096) throw new AuthenticationError();
  let account;
  try { account = await sessionAccount(secret).get(); }
  catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 401 || code === 403) throw new AuthenticationError();
    throw new AuthenticationError(503);
  }
  if (!authorizedAccount(account, config.allowedUserIds)) throw new AuthenticationError(403);
  return { id: account.$id, name: account.name };
}

// React cache is scoped to a server render, not a cross-request authorization cache.
export const requireUser = cache(async () => {
  const config = dashboardConfig();
  if (config.mode === 'local') return { id: 'local-operator', name: 'Lokaler Betreiber' };
  return validateSession((await cookies()).get(config.cookieName)?.value);
});

export async function createLogin(email: string, password: string) {
  const config = dashboardConfig();
  if (config.mode !== 'production' || !config.appwriteEndpoint || !config.projectId) throw new AuthenticationError();
  const key = await serverSecret('APPWRITE_SSR_KEY');
  const account = new Account(new DashboardClient().setEndpoint(config.appwriteEndpoint).setProject(config.projectId).setKey(key));
  const session = await account.createEmailPasswordSession({ email, password });
  if (!session.secret) throw new AuthenticationError(503);
  try {
    if (!Number.isFinite(Date.parse(session.expire)) || Date.parse(session.expire) <= Date.now()) throw new AuthenticationError(503);
    await validateSession(session.secret);
  }
  catch (error) {
    await sessionAccount(session.secret).deleteSession({ sessionId: 'current' }).catch(() => undefined);
    throw error;
  }
  return { secret: session.secret, expires: new Date(session.expire) };
}

export async function revokeSession(secret: string) {
  try { await sessionAccount(secret).deleteSession({ sessionId: 'current' }); }
  catch (error) {
    if (![401, 404].includes((error as { code: number }).code)) throw new AuthenticationError(503);
  }
}
