import { createHash } from 'node:crypto';

// Per-process protection complements the shared ingress limit in production.
// No raw email addresses or passwords are retained in the limiter.
export function createLoginLimiter() {
  const accounts = new Map();
  let globalWindow = { start: 0, count: 0 };
  return (email, now = Date.now()) => {
    for (const [key, value] of accounts) if (now - value.start >= 900000) accounts.delete(key);
    if (now - globalWindow.start >= 60000) globalWindow = { start: now, count: 0 };
    if (++globalWindow.count > 60) return false;
    const key = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
    const entry = accounts.get(key) || { start: now, count: 0 };
    if (!accounts.has(key) && accounts.size >= 1000) return false;
    accounts.set(key, entry);
    return ++entry.count <= 10;
  };
}
