import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withProcessLock } from '../src/outreach/process-lock.mjs';

async function folder(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sales-flock-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && basename(directory).startsWith('sales-flock-'));
    await rm(directory, { recursive: true, force: true });
  });
  return join(directory, 'shared.flock');
}

test('Linux kernel lock excludes a concurrent operation and releases normally', { skip: process.platform !== 'linux' }, async t => {
  const path = await folder(t);
  let release;
  const entered = Promise.withResolvers();
  const first = withProcessLock(() => { entered.resolve(); return new Promise(resolve => { release = resolve; }); }, path);
  await entered.promise;
  try { await assert.rejects(() => withProcessLock(() => assert.fail('must not enter'), path, { timeoutSeconds: 0 }), /belegt/); }
  finally { release(); await first; }
  assert.equal(await withProcessLock(async () => 'released', path), 'released');
});

test('parent SIGKILL releases kernel lock without deleting state or lock file', { skip: process.platform !== 'linux' }, async t => {
  const path = await folder(t);
  const module = new URL('../src/outreach/process-lock.mjs', import.meta.url).href;
  const script = `import { withProcessLock } from ${JSON.stringify(module)}; await withProcessLock(async () => { process.stdout.write('entered\\n'); await new Promise(() => {}); }, ${JSON.stringify(path)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('child did not acquire lock')), 5000);
    child.stdout.on('data', value => { text += value; if (text.includes('entered\n')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('child exited too soon')); });
  });
  await assert.rejects(() => withProcessLock(() => assert.fail('must not enter'), path, { timeoutSeconds: 0 }), /belegt/);
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  assert.equal(await withProcessLock(async () => 'recovered', path, { timeoutSeconds: 3 }), 'recovered');
});
