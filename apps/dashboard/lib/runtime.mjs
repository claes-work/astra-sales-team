import { localRequestAllowed } from './input.mjs';

export class ConfigurationError extends Error {
  constructor() { super('Das Dashboard ist noch nicht vollständig eingerichtet.'); }
}

function baseUrl(value, httpsOnly = false) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || (httpsOnly && url.protocol !== 'https:')
      || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch { throw new ConfigurationError(); }
}

export function dashboardConfig(env = process.env) {
  if (env.DASHBOARD_MODE === 'local') {
    const port = env.PORT || '3210', apiPort = env.SALES_API_PORT || '8787';
    if (![port, apiPort].every(p => /^\d{4,5}$/.test(p) && +p <= 65535)) throw new ConfigurationError();
    return { mode: 'local', port, origin: `http://127.0.0.1:${port}`, apiUrl: `http://127.0.0.1:${apiPort}`, cookieName: 'sales-local-session' };
  }
  if (env.DASHBOARD_MODE !== 'production') throw new ConfigurationError();
  const origin = baseUrl(env.DASHBOARD_ORIGIN, true);
  if (new URL(origin).pathname !== '/') throw new ConfigurationError();
  const appwriteEndpoint = baseUrl(env.APPWRITE_ENDPOINT);
  const projectId = env.APPWRITE_PROJECT_ID;
  const allowedUserIds = (env.DASHBOARD_ALLOWED_USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!projectId || !allowedUserIds.length || !allowedUserIds.every(id => /^[\w.-]{1,36}$/.test(id))
    || !(env.APPWRITE_SSR_KEY_FILE || env.APPWRITE_SSR_KEY)
    || !(env.SALES_API_TOKEN_FILE || env.SALES_API_TOKEN)) throw new ConfigurationError();
  return { mode: 'production', origin, apiUrl: baseUrl(env.SALES_API_URL), appwriteEndpoint, projectId, allowedUserIds,
    cookieName: '__Host-sales-session' };
}

export function dashboardRequestAllowed(headers, config, mutation = false) {
  if (config.mode === 'local') return localRequestAllowed(headers, config.port, mutation);
  const expectedHost = new URL(config.origin).host;
  if (headers.get('host') !== expectedHost) return false;
  if (headers.get('x-forwarded-host') && headers.get('x-forwarded-host') !== expectedHost) return false;
  if (headers.get('x-forwarded-proto') && headers.get('x-forwarded-proto') !== 'https') return false;
  const origin = headers.get('origin');
  if ((origin && origin !== config.origin) || (mutation && origin !== config.origin)) return false;
  const site = headers.get('sec-fetch-site');
  return !site || site === 'same-origin' || (!mutation && site === 'none');
}

export function safeReturnPath(value) {
  return typeof value === 'string' && /^\/(?:days|leads|messages|drafts)(?:[/?]|$)/.test(value)
    && !/[\\\r\n]/.test(value) && value.length <= 2048 ? value : '/days';
}

export function authorizedAccount(account, allowedUserIds) {
  return Boolean(account && account.status === true && allowedUserIds.includes(account.$id));
}
