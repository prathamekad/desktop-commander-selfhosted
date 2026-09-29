import { ChildProcess, spawn } from 'child_process';
import fs, { promises as fsp } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SELFHOST_DIR } from './credentials.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCK_PATH = path.join(SELFHOST_DIR, 'supervisor.lock');
const SUPERVISOR_LOG = path.join(SELFHOST_DIR, 'supervisor.log');

let shuttingDown = false;
const children = new Map<string, ChildProcess>();
let lockHandle: fsp.FileHandle | null = null;

async function appendSupervisor(message: string): Promise<void> {
  await fsp.mkdir(SELFHOST_DIR, { recursive: true, mode: 0o700 });
  await fsp.appendFile(
    SUPERVISOR_LOG,
    `${new Date().toISOString()} ${message}\n`,
    'utf8'
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(): Promise<void> {
  await fsp.mkdir(SELFHOST_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      lockHandle = await fsp.open(LOCK_PATH, 'wx', 0o600);
      await lockHandle.writeFile(String(process.pid));
      return;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const raw = await fsp.readFile(LOCK_PATH, 'utf8').catch(() => '');
      const pid = Number(raw.trim());
      if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) {
        throw new Error(`Self-host supervisor is already running as PID ${pid}`);
      }
      await fsp.rm(LOCK_PATH, { force: true });
    }
  }
  throw new Error('Could not acquire supervisor lock');
}

async function releaseLock(): Promise<void> {
  await lockHandle?.close().catch(() => undefined);
  lockHandle = null;
  await fsp.rm(LOCK_PATH, { force: true }).catch(() => undefined);
}
function logStream(name: string): fs.WriteStream {
  return fs.createWriteStream(path.join(SELFHOST_DIR, `${name}.log`), {
    flags: 'a',
    encoding: 'utf8'
  });
}

function startManaged(name: 'gateway' | 'device'): void {
  if (shuttingDown) return;
  const script = path.join(__dirname, `${name}.js`);
  const stdout = logStream(name);
  const stderr = logStream(name);
  const startedAt = Date.now();

  const child = spawn(process.execPath, [script], {
    windowsHide: true,
    cwd: path.resolve(__dirname, '..', '..'),
    env: {
      ...process.env,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  children.set(name, child);
  child.stdout?.pipe(stdout, { end: false });
  child.stderr?.pipe(stderr, { end: false });
  void appendSupervisor(`${name} started pid=${child.pid ?? 'unknown'}`);

  child.once('exit', (code, signal) => {
    children.delete(name);
    stdout.end();
    stderr.end();
    const runtime = Date.now() - startedAt;
    void appendSupervisor(
      `${name} exited code=${code ?? 'null'} signal=${signal ?? 'null'} runtimeMs=${runtime}`
    );

    if (!shuttingDown) {
      const delay = runtime >= 60_000 ? 1_000 : 5_000;
      setTimeout(() => startManaged(name), delay);
    }
  });
}

async function stopChildren(): Promise<void> {
  const active = [...children.entries()];
  for (const [, child] of active) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }

  await Promise.race([
    Promise.all(active.map(([, child]) =>
      child.exitCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => child.once('exit', () => resolve()))
    )),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000))
  ]);

  for (const [, child] of active) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await appendSupervisor(`shutdown requested signal=${signal}`);
  await stopChildren();
  await releaseLock();
}

async function main(): Promise<void> {
  await acquireLock();
  await appendSupervisor(`supervisor started pid=${process.pid}`);
  startManaged('gateway');
  startManaged('device');

  process.once('SIGINT', () => {
    void shutdown('SIGINT').finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').finally(() => process.exit(0));
  });
  process.once('SIGHUP', () => {
    void shutdown('SIGHUP').finally(() => process.exit(0));
  });
}

main().catch(async (error) => {
  await appendSupervisor(
    `fatal: ${error instanceof Error ? error.message : String(error)}`
  ).catch(() => undefined);
  await releaseLock();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
