import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { configurationStatus } from './brevo.mjs';
import { syncReplies } from './inbound.mjs';
import { strategySchema, personalizationSchema } from './profiles.mjs';
import { individualExperimentSchema } from './experiment.mjs';
import { PipelineLedger } from '../operations/ledger.mjs';
import { DashboardData } from '../operations/dashboard.mjs';
import { WebsiteQuizIngest, WEBSITE_QUIZ_PATH, quizAuthorized, QuizIngestError } from '../integrations/website-quiz.mjs';

const localDirectory = fileURLToPath(new URL('../../.local/outreach/', import.meta.url));
async function tokenFile() {
  await mkdir(localDirectory, { recursive: true });
  const path = join(localDirectory, 'api-token.txt');
  try { return (await readFile(path, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('hex');
    await writeFile(path, token + '\n', { flag: 'wx', mode: 0o600 });
    return token;
  }
}
function authorized(value, token) {
  const got = Buffer.from(value ?? ''); const expected = Buffer.from(`Bearer ${token}`);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
async function body(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new Error('JSON-Inhalt erforderlich.');
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 65536) throw new Error('Anfrage größer als 64 KiB.'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON-Objekt erforderlich.');
  return value;
}

export function createApi({ service, repo, env, token }) {
  if (!token || token.length < 32) throw new Error('Lokaler API-Schlüssel fehlt oder ist zu kurz.');
  const ledger = new PipelineLedger({repo,now:service.now,lock:service.lock});
  const dashboard = new DashboardData(service);
  const quiz = new WebsiteQuizIngest({repo,env,now:service.now,lock:service.lock});
  if(env?.WEBSITE_QUIZ_BEARER_TOKEN && env.WEBSITE_QUIZ_BEARER_TOKEN === token)throw new Error('Website- und Operator-Zugang müssen getrennte Schlüssel haben.');
  const production=env?.NODE_ENV==='production';
  const external=production&&env?.OUTREACH_API_HOST==='0.0.0.0';
  const allowedHosts=(env?.OUTREACH_API_ALLOWED_HOSTS??'').split(',').map(s=>s.trim()).filter(Boolean);
  const allowedOrigins=(env?.OUTREACH_API_ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean);
  if(external&&(!allowedHosts.length||allowedHosts.some(h=>!/^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(h))))throw new Error('Explizite API-Hostnamen für Produktionsbetrieb erforderlich.');
  if(allowedOrigins.some(o=>{try{const u=new URL(o);return u.protocol!=='https:'||u.origin!==o;}catch{return true;}}))throw new Error('API-Ursprünge müssen vollständige HTTPS-Origins sein.');
  return createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    // Bind to loopback and reject DNS rebinding/cross-origin requests. No permissive CORS.
    const expectedHost = `127.0.0.1:${req.socket.localPort}`;
    if (external ? (!allowedHosts.includes(req.headers.host)||(req.headers.origin&&!allowedOrigins.includes(req.headers.origin)))
      : (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`))) return send(403, { error: 'Fremder Host oder Ursprung abgewiesen.' });
    let requestPath;
    try{requestPath=new URL(req.url, `http://${expectedHost}`).pathname;}catch{return send(400,{error:'Ungültige Anfrage-URL.'});}
    if(requestPath===WEBSITE_QUIZ_PATH){
      if(!quizAuthorized(req.headers.authorization,env))return send(401,{status:'unauthorized'});
      if(req.method!=='POST')return send(405,{status:'method_not_allowed'});
      let input;
      try{input=await body(req);}catch{return send(400,{status:'invalid_payload'});}
      try{const result=await quiz.ingest(input);return send(result.statusCode,result.body);}
      catch(error){return send(error instanceof QuizIngestError?error.statusCode:503,{status:error instanceof QuizIngestError?error.code:'persistence_unavailable'});}
    }
    if (!authorized(req.headers.authorization, token)) return send(401, { error: 'Lokaler API-Zugang erforderlich.' });
    try {
      const url = new URL(req.url, `http://${expectedHost}`);
      const path = url.pathname;
      let result;
      if (req.method === 'GET') {
        if (path === '/v1/status') result = { database: repo.database, config: configurationStatus(env), controls: await repo.get('outreach_controls', 'default') };
        else if (path === '/v1/ramp') result = await service.ramp.snapshot();
        else if (path === '/v1/pipeline/report') result = await ledger.report({day:url.searchParams.get('day')||undefined,clientId:url.searchParams.get('client')||undefined,runId:url.searchParams.get('run')||undefined});
        else if (path === '/v1/dashboard/overview') result = await dashboard.overview();
        else if (path === '/v1/dashboard/leads') result = await dashboard.leads(Object.fromEntries(url.searchParams));
        else if (/^\/v1\/dashboard\/leads\/[\w-]+$/.test(path)) result = await dashboard.lead(path.split('/')[4]);
        else if (path === '/v1/dashboard/days') result = await dashboard.days();
        else if (/^\/v1\/dashboard\/days\/\d{4}-\d{2}-\d{2}$/.test(path)) result = await dashboard.day(path.split('/')[4]);
        else if (/^\/v1\/dashboard\/messages\/[\w-]+$/.test(path)) result = await dashboard.message(path.split('/')[4]);
        else if (path === '/v1/campaigns') result = await repo.list('campaigns');
        else if (path === '/v1/companies') result = await repo.list('companies');
        else if (path === '/v1/contacts') result = await repo.list('contacts');
        else if (path === '/v1/assessments') result = await repo.list('assessments');
        else if (path === '/v1/events') result = await repo.list('outreach_events');
        else if (path === '/v1/experiments') result = await repo.list('outreach_experiments');
        else if (path === '/v1/messages') result = await repo.list('outreach_messages');
        else if (path === '/v1/content-schemas') result = { strategy: strategySchema, personalization: personalizationSchema, experiment: individualExperimentSchema };
        else if (path === '/v1/content') result = await service.listContent({ clientId: url.searchParams.get('client'), kind: url.searchParams.get('kind') || undefined, versions: url.searchParams.get('versions') === 'true' });
        else if (/^\/v1\/(drafts|versions)\/[\w-]+(?:\/export)?$/.test(path)) {
          const input = { id: path.split('/')[3], version: path.split('/')[2] === 'versions' };
          result = path.endsWith('/export') ? await service.exportContent(input) : await service.getContent(input);
        }
        else if (/^\/v1\/drafts\/[\w-]+\/preview$/.test(path)) result = await service.previewDraft({ draftId: path.split('/')[3] });
        else if (/^\/v1\/messages\/[\w-]+\/preview$/.test(path)) result = await service.preview(path.split('/')[3]);
        else if (/^\/v1\/experiments\/[\w-]+\/report$/.test(path)) result = await service.report(path.split('/')[3]);
        else return send(404, { error: 'Route unbekannt.' });
      } else if (req.method === 'POST' || req.method === 'PATCH') {
        const input = await body(req);
        const routes = {
          'POST /v1/pipeline/runs': () => ledger.start(input),
          'POST /v1/pipeline/steps': () => ledger.step(input),
          'POST /v1/pipeline/finish': () => ledger.finish(input),
          'POST /v1/ramp/configure': () => service.ramp.configure(input),
          'POST /v1/ramp/decisions': () => service.ramp.decide(input),
          'POST /v1/lead-activities': () => dashboard.activity(input),
          'POST /v1/experiments': () => service.createExperiment(input),
          'POST /v1/enrollments': () => service.enroll(input),
          'POST /v1/permissions': () => service.permission(input),
          'POST /v1/approve': () => service.approve(input),
          'PATCH /v1/controls': () => service.controls(input),
          'PATCH /v1/experiment-status': () => service.experimentStatus(input),
          'POST /v1/send': () => service.sendOne(input),
          'POST /v1/sync/provider': () => service.syncProvider(input),
          'POST /v1/sync/replies': () => syncReplies({ service, env }),
          'POST /v1/outcomes': () => service.recordOutcome(input),
          'POST /v1/drafts': () => service.saveDraft(input),
          'POST /v1/versions': () => service.publishDraft(input),
          'POST /v1/briefings': () => service.contentBriefing(input),
          'POST /v1/experiments/apply': () => service.applyExperimentVersion(input),
        };
        const action = req.method === 'PATCH' && /^\/v1\/drafts\/[\w-]+$/.test(path)
          ? () => service.editDraft({ ...input, draftId: path.split('/')[3] }) : routes[`${req.method} ${path}`];
        if (!action) return send(404, { error: 'Route unbekannt.' });
        result = await action();
      } else return send(405, { error: 'Methode nicht erlaubt.' });
      send(200, result);
    } catch (error) {
      // Production callers must not receive arbitrary provider/SDK/parser text.
      // Typed quiz responses are handled separately above; local tools retain
      // their existing validation diagnostics.
      const status = production && Number.isInteger(error?.status) && error.status >= 500 ? 503 : 400;
      send(status, production ? { error: 'Anfrage konnte nicht verarbeitet werden.', code: 'request_failed' } : { error: error.message });
    }
  });
}

export async function startApi({ service, repo, env, port = 8787 }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Ungültiger lokaler API-Port.');
  const host=env.OUTREACH_API_HOST??'127.0.0.1';
  if(host!=='127.0.0.1'&&!(host==='0.0.0.0'&&env.NODE_ENV==='production'))throw new Error('Externe Bindung nur ausdrücklich im Produktionsbetrieb erlaubt.');
  if(env.NODE_ENV==='production'&&(!env.OUTREACH_API_TOKEN||env.OUTREACH_API_TOKEN.length<32))throw new Error('Produktions-API benötigt eigenen Operator-Schlüssel.');
  const token = env.OUTREACH_API_TOKEN || await tokenFile();
  const server = createApi({ service, repo, env, token });
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  console.log(`Vertriebs-API auf ${host}:${port}; Zugang ausschließlich serverseitig. Kein automatischer Versand.`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; server.close(); server.closeIdleConnections(); await repo.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return server;
}
