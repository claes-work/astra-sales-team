import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

// Linux advisory lock. stdin closes on parent death, including SIGKILL; the
// helper then exits and the kernel releases the lock. Never delete lock files.
export async function withProcessLock(work, path, { timeoutSeconds = 30 } = {}) {
  if (process.platform !== 'linux' || !isAbsolute(path)) throw new Error('Linux-Prozesssperre braucht Linux und einen absoluten Pfad.');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 60) throw new Error('Ungültige Sperrwartezeit.');
  await mkdir(dirname(path), { recursive: true });
  const child = spawn('flock', ['-F', '-x', '-w', String(timeoutSeconds), path, process.execPath, '-e',
    "process.stdout.write('locked\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));"],
  { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  child.stdin.on('error', () => {});
  let acquired = false, spawnFailed = false;
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Prozesssperre antwortet nicht.')); }, (timeoutSeconds + 5) * 1000);
      const done = fn => { clearTimeout(timeout); fn(); };
      child.once('error', () => { spawnFailed = true; done(() => reject(new Error('flock-Prozesssperre nicht verfügbar.'))); });
      child.once('exit', () => { if (!acquired) done(() => reject(new Error('Prozesssperre belegt.'))); });
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (!acquired && output.includes('locked\n')) { acquired = true; done(resolve); }
      });
    });
    return await work();
  } finally {
    // Wait for release so an immediately following operation does not race it.
    if (!spawnFailed && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 2000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
        child.stdin.end();
      });
    }
  }
}
