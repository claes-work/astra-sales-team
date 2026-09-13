import { fork, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dashboard = join(root, 'apps/dashboard');
if (!existsSync(join(dashboard, 'node_modules/next/dist/bin/next'))) {
  console.error('Zuerst npm ci und npm --prefix apps/dashboard ci ausführen.');
  process.exit(1);
}
// Drop all application credentials inherited from the caller. The demo creates
// its own loopback API token in the ignored .local/ directory.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(APPWRITE|BREVO|OUTREACH|SALES|DASHBOARD|WEBSITE|HOSTINGER|GOOGLE|NEXT_PUBLIC)_/.test(key)));
env.NODE_ENV = 'development';
env.NEXT_TELEMETRY_DISABLED = '1';
env.DASHBOARD_TEST_MODE = 'true';
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill();
}
const api = fork(join(root, 'scripts/demo-api.mjs'), { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true });
children.push(api);
const startup = setTimeout(() => { console.error('Demo-API konnte nicht rechtzeitig starten.'); stop(1); }, 30000);
api.once('message', message => {
  if (!message?.ready || stopping) return;
  clearTimeout(startup);
  const ui = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3210'], {
    cwd: dashboard, env: { ...env, DASHBOARD_MODE: 'local', SALES_API_PORT: '8787', PORT: '3210' }, stdio: 'inherit', windowsHide: true,
  });
  children.push(ui);
  ui.once('error', () => stop(1));
  ui.once('exit', code => stop(code ?? 1));
  console.log('Dashboard: http://127.0.0.1:3210 — Beenden mit Strg+C.');
});
api.once('error', () => { clearTimeout(startup); stop(1); });
api.once('exit', code => { clearTimeout(startup); stop(code ?? 1); });
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
