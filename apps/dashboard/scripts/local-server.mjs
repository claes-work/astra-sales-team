import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dashboardConfig } from '../lib/runtime.mjs';

if (process.env.DASHBOARD_MODE && process.env.DASHBOARD_MODE !== 'local') throw new Error('Dieser Befehl startet ausschließlich das lokale Dashboard. Produktion: node server.js im Standalone-Image.');
const mode = process.argv[2];
if (!['dev', 'start'].includes(mode)) throw new Error('Modus dev oder start erforderlich.');
const env = { ...process.env, DASHBOARD_MODE: 'local', PORT: process.env.PORT || '3210' };
dashboardConfig(env);
const cwd = fileURLToPath(new URL('..', import.meta.url));
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', mode, '--hostname', '127.0.0.1', '--port', env.PORT], { cwd, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
