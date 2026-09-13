import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalAppwrite, LIVE_DB, DEMO_DB } from './appwrite.mjs';
import { BrevoProvider, configurationStatus, loadOutreachEnv } from './brevo.mjs';
import { loadExperiment, individualExperimentSchema } from './experiment.mjs';
import { loadContentFile, strategySchema, personalizationSchema } from './profiles.mjs';
import { provision } from './provision.mjs';
import { OutreachService } from './service.mjs';
import { markdownReport } from './report.mjs';
import { runDemo } from './demo.mjs';
import { MemoryRepository } from './memory.mjs';
import { PipelineLedger } from '../operations/ledger.mjs';
import { DashboardData } from '../operations/dashboard.mjs';

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith('--') || key in result) throw new Error('Ungültige oder doppelte Option.');
    if (['--execute', '--demo', '--watch', '--versions', '--version'].includes(key)) result[key] = true;
    else if (args[i + 1] && !args[i + 1].startsWith('--')) result[key] = args[++i];
    else throw new Error('Optionswert fehlt.');
  }
  return result;
}
const jsonFile = async path => { if (!path) throw new Error('--file fehlt.'); return JSON.parse(await readFile(path, 'utf8')); };

export async function main(args = process.argv.slice(2)) {
  const [command = 'help', ...rest] = args;
  if (command === 'help' || command === '--help') {
    console.log('Outreach: check | verify-provider | init | list | experiment:create | experiment:apply | experiment:status | enroll | preview | permission | approve | controls | send | sync | outcome | report | demo | api | import-reply | sync-replies | worker | content:schemas | content:list | content:get | content:export | content:save | content:edit | content:publish | content:brief | content:preview | pipeline:start | pipeline:step | pipeline:finish | pipeline:report | ramp:status | ramp:configure | ramp:decide | dashboard:overview | lead:activity. Anleitungen: docs/setup.md und docs/architecture.md. Kein Versand ohne --execute und lokale Aktivierung.');
    return;
  }
  const opt = options(rest);
  const allowed = {
    'pipeline:start':['--demo','--file'], 'pipeline:step':['--demo','--file'], 'pipeline:finish':['--demo','--file'],
    'pipeline:report':['--demo','--day','--client','--run','--out'],
    'ramp:status':['--demo'], 'ramp:configure':['--demo','--file'], 'ramp:decide':['--demo','--file'],
    'dashboard:overview':['--demo','--out'], 'lead:activity':['--demo','--file'],
    check: [], 'verify-provider': [], init: ['--demo'], list: ['--demo'], 'experiment:create': ['--demo', '--file', '--client', '--campaign'],
    'experiment:status': ['--demo', '--experiment', '--status'], enroll: ['--demo', '--experiment', '--assessment', '--contact', '--personalization'],
    'experiment:apply': ['--demo', '--client', '--campaign', '--version-id'],
    'content:schemas': [], 'content:list': ['--demo', '--client', '--kind', '--versions'],
    'content:get': ['--demo', '--id', '--version'], 'content:export': ['--demo', '--id', '--version', '--out'],
    'content:save': ['--demo', '--client', '--kind', '--file', '--hash'], 'content:edit': ['--demo', '--draft', '--file', '--hash'],
    'content:publish': ['--demo', '--draft', '--hash'], 'content:preview': ['--demo', '--draft', '--out'],
    'content:brief': ['--demo', '--client', '--version-id', '--assessment', '--contact', '--out'],
    preview: ['--demo', '--message'], permission: ['--demo', '--file'], approve: ['--demo', '--message', '--hash', '--by'],
    controls: ['--demo', '--file'], send: ['--demo', '--message', '--execute'], sync: ['--demo', '--limit'], outcome: ['--demo', '--file'],
    report: ['--demo', '--experiment', '--out'], demo: ['--out'], api: ['--demo', '--port'], 'import-reply': ['--demo', '--file'], 'sync-replies': [],
    worker: ['--execute', '--watch', '--interval'],
  };
  if (!(command in allowed) || Object.keys(opt).some(k => !allowed[command].includes(k))) throw new Error('Unbekannter Befehl oder unzulässige Option.');
  if (command === 'content:schemas') { console.log(JSON.stringify({ strategy: strategySchema, personalization: personalizationSchema, experiment: individualExperimentSchema }, null, 2)); return; }
  const env = loadOutreachEnv();
  const provider = new BrevoProvider({ env });
  if (command === 'check') { console.log(JSON.stringify(configurationStatus(env), null, 2)); return; }
  if (command === 'verify-provider') { console.log(JSON.stringify(await provider.verify(), null, 2)); return; }
  if (command === 'demo' && opt['--execute']) throw new Error('Demo verwendet nie echten Versand.');
  const repo = command === 'demo' ? new MemoryRepository() : await new LocalAppwrite(opt['--demo'] ? DEMO_DB : LIVE_DB).connect();
  const service = new OutreachService({ repo, provider, env });
  const ledger = new PipelineLedger({repo});
  let result;
  let keepOpen = false;
  try {
    switch (command) {
      case 'pipeline:start': result = await ledger.start(await jsonFile(opt['--file'])); break;
      case 'pipeline:step': result = await ledger.step(await jsonFile(opt['--file'])); break;
      case 'pipeline:finish': result = await ledger.finish(await jsonFile(opt['--file'])); break;
      case 'pipeline:report': result = await ledger.report({day:opt['--day'],clientId:opt['--client'],runId:opt['--run']}); break;
      case 'ramp:status': result = await service.ramp.snapshot(); break;
      case 'ramp:configure': result = await service.ramp.configure(await jsonFile(opt['--file'])); break;
      case 'ramp:decide': result = await service.ramp.decide(await jsonFile(opt['--file'])); break;
      case 'dashboard:overview': result = await new DashboardData(service).overview(); break;
      case 'lead:activity': result = await new DashboardData(service).activity(await jsonFile(opt['--file'])); break;
      case 'init': result = await provision(repo); break;
      case 'list': result = { campaigns: await repo.list('campaigns'), experiments: await repo.list('outreach_experiments'), controls: await repo.get('outreach_controls', 'default'), messages: await repo.list('outreach_messages') }; break;
      case 'experiment:create': result = await service.createExperiment({ clientId: opt['--client'], campaignId: opt['--campaign'], definition: await loadExperiment(opt['--file']) }); break;
      case 'experiment:status': result = await service.experimentStatus({ experimentId: opt['--experiment'], status: opt['--status'] }); break;
      case 'enroll': result = await service.enroll({ experimentId: opt['--experiment'], assessmentId: opt['--assessment'], contactId: opt['--contact'], personalizationVersionId: opt['--personalization'] }); break;
      case 'experiment:apply': result = await service.applyExperimentVersion({ clientId: opt['--client'], campaignId: opt['--campaign'], versionId: opt['--version-id'] }); break;
      case 'content:list': result = await service.listContent({ clientId: opt['--client'], kind: opt['--kind'], versions: Boolean(opt['--versions']) }); break;
      case 'content:get': result = await service.getContent({ id: opt['--id'], version: Boolean(opt['--version']) }); break;
      case 'content:export': result = await service.exportContent({ id: opt['--id'], version: Boolean(opt['--version']) }); break;
      case 'content:save': result = await service.saveDraft({ clientId: opt['--client'], kind: opt['--kind'], definition: await loadContentFile(opt['--file']), expectedHash: opt['--hash'] }); break;
      case 'content:edit': result = await service.editDraft({ draftId: opt['--draft'], definition: await loadContentFile(opt['--file']), expectedHash: opt['--hash'] }); break;
      case 'content:publish': result = await service.publishDraft({ draftId: opt['--draft'], expectedHash: opt['--hash'] }); break;
      case 'content:brief': result = await service.contentBriefing({ clientId: opt['--client'], experimentVersionId: opt['--version-id'], assessmentId: opt['--assessment'], contactId: opt['--contact'] || null }); break;
      case 'content:preview': result = await service.previewDraft({ draftId: opt['--draft'] }); break;
      case 'preview': result = await service.preview(opt['--message']); break;
      case 'permission': result = await service.permission(await jsonFile(opt['--file'])); break;
      case 'approve': result = await service.approve({ messageId: opt['--message'], contentHash: opt['--hash'], approvedBy: opt['--by'] }); break;
      case 'controls': result = await service.controls(await jsonFile(opt['--file'])); break;
      case 'send': result = await service.sendOne({ messageId: opt['--message'], execute: Boolean(opt['--execute']) }); break;
      case 'sync': result = await service.syncProvider({ maxMessages: opt['--limit'] === undefined ? 50 : Number(opt['--limit']) }); break;
      case 'outcome': result = await service.recordOutcome(await jsonFile(opt['--file'])); break;
      case 'report': result = await service.report(opt['--experiment']); break;
      case 'demo': result = await runDemo(repo); break;
      case 'api': {
        const { startApi } = await import('./http.mjs');
        await startApi({ service, repo, env, port: opt['--port'] === undefined ? 8787 : Number(opt['--port']) });
        keepOpen = true;
        return;
      }
      case 'import-reply': {
        const { importReply } = await import('./inbound.mjs');
        result = await importReply({ service, source: await readFile(opt['--file']), origin: 'manual-eml' }); break;
      }
      case 'sync-replies': {
        const { syncReplies } = await import('./inbound.mjs');
        result = await syncReplies({ service, env }); break;
      }
      case 'worker': {
        const { workerCycle, watchWorker } = await import('./worker.mjs');
        if (opt['--watch']) await watchWorker({ service, env, execute: Boolean(opt['--execute']) }, opt['--interval'] ? Number(opt['--interval']) : 180);
        else result = await workerCycle({ service, env, execute: Boolean(opt['--execute']) });
        break;
      }
    }
    if (opt['--out']) {
      const path = resolve(opt['--out']); await mkdir(dirname(path), { recursive: true });
      const output = /^(content|pipeline|dashboard):/.test(command) ? (result.yaml ?? JSON.stringify(result, null, 2) + '\n') : markdownReport(result.report ?? result);
      await writeFile(path, output, 'utf8');
    }
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  } finally { if (!keepOpen) await repo.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
