import { MemoryRepository } from '../src/outreach/memory.mjs';
import { runDemo, DemoProvider, demoEnv } from '../src/outreach/demo.mjs';
import { OutreachService } from '../src/outreach/service.mjs';
import { startApi } from '../src/outreach/http.mjs';

// Deliberately do not load .env.local or inherit provider/database configuration.
const repo = new MemoryRepository();
await runDemo(repo);
const env = { ...demoEnv, OUTREACH_SEND_ENABLED: 'false' };
const service = new OutreachService({ repo, provider: new DemoProvider(), env });
await startApi({ repo, service, env, port: 8787 });
console.log('Demo: vier erfundene Firmen, simulierte Ergebnisse, Daten nur im Arbeitsspeicher.');
if (process.send) process.send({ ready: true });
