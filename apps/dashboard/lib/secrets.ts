import 'server-only';
import { readFile } from 'node:fs/promises';
import { ConfigurationError } from './runtime.mjs';

export async function serverSecret(name: string, localFallback?: string) {
  const file = process.env[`${name}_FILE`];
  let value: string;
  try { value = file ? await readFile(file, 'utf8') : process.env[name] || (localFallback ? await readFile(localFallback, 'utf8') : ''); }
  catch { throw new ConfigurationError(); }
  const secret = value.trim();
  if (!secret || secret.length > 16384) throw new ConfigurationError();
  return secret;
}
