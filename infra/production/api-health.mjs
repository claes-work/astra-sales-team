import { request } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Container-local authenticated health read. Never print the token, response
// body, controls or customer data; diagnostics use only the process exit code.
export function checkApiHealth(env = process.env, requestImpl = request) {
  const token = env.OUTREACH_API_TOKEN;
  const allowed = (env.OUTREACH_API_ALLOWED_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean);
  const host = env.OUTREACH_API_HEALTH_HOST || allowed[0];
  const port = Number(env.OUTREACH_API_PORT || 8787);
  if (!token || token.length < 32 || /[\r\n]/.test(token) || !host || !allowed.includes(host)
    || !/^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(host) || !Number.isInteger(port) || port < 1024 || port > 65535)
    return Promise.resolve(false);
  return new Promise(resolve => {
    let finished = false;
    const finish = result => { if (!finished) { finished = true; resolve(result); } };
    const req = requestImpl({ hostname: '127.0.0.1', port, path: '/v1/status', method: 'GET', timeout: 5000,
      headers: { host, authorization: `Bearer ${token}`, accept: 'application/json' } }, res => {
      let length = 0; const chunks = [];
      res.on('data', chunk => { length += chunk.length; if (length > 65536) { res.destroy(); finish(false); } else chunks.push(chunk); });
      res.on('error', () => finish(false));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          finish(res.statusCode === 200 && body.database === (env.APPWRITE_DATABASE_ID || 'lead-research')
            && typeof body.controls?.paused === 'boolean');
        } catch { finish(false); }
      });
    });
    req.on('error', () => finish(false));
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.end();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkApiHealth().then(ok => { process.exitCode = ok ? 0 : 1; }).catch(() => { process.exitCode = 1; });
}
