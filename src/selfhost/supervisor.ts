import { ChildProcess, spawn, spawnSync } from 'child_process';
import fs, { promises as fsp } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SELFHOST_DIR } from './credentials.js';
import { loadRuntimeConfig } from './runtime-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCK_PATH = path.join(SELFHOST_DIR, 'supervisor.lock');
const SUPERVISOR_LOG = path.join(SELFHOST_DIR, 'supervisor.log');

let shuttingDown = false;
const children = new Map<string, ChildProcess>();
let lockHandle: fsp.FileHandle | null = null;
let tailscaleTimer: NodeJS.Timeout | null = null;
let tailscaleCheckRunning = false;

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

function startManaged(name: 'gateway' | 'device' | 'public-proxy' | 'dashboard'): void {
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

function runTailscale(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const exe = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
  const result = spawnSync(exe, args, {
    windowsHide: true,
    encoding: 'utf8'
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

async function ensureTailscaleFunnel(): Promise<void> {
  if (process.platform !== 'win32' || shuttingDown || tailscaleCheckRunning) return;
  tailscaleCheckRunning = true;

  try {
    const runtime = await loadRuntimeConfig();
    if (!runtime.publicBaseUrl) return;

    const publicUrl = new URL(runtime.publicBaseUrl);
    if (!publicUrl.hostname.endsWith('.ts.net')) return;

    const port = runtime.publicPort ?? 8788;
    let status = runTailscale(['status', '--json']);
    let backendState = '';

    if (status.ok) {
      try {
        backendState = JSON.parse(status.stdout)?.BackendState ?? '';
      } catch {}
    }

    if (backendState !== 'Running') {
      const ipnPath = path.join(
        process.env.ProgramFiles ?? 'C:\\Program Files',
        'Tailscale',
        'tailscale-ipn.exe'
      );
      if (fs.existsSync(ipnPath)) {
        const ipn = spawn(ipnPath, [], {
          detached: true,
          windowsHide: true,
          stdio: 'ignore'
        });
        ipn.unref();
        await appendSupervisor(
          `tailscale backend state=${backendState || 'unknown'}; launched tailscale-ipn for recovery`
        );
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        status = runTailscale(['status', '--json']);
        if (status.ok) {
          try {
            backendState = JSON.parse(status.stdout)?.BackendState ?? '';
          } catch {}
        }
      }
    }

    if (backendState !== 'Running') {
      await appendSupervisor(
        `tailscale auto-heal deferred: backend state=${backendState || 'unknown'} stderr=${status.stderr.trim()}`
      );
      return;
    }

    const funnelStatus = runTailscale(['funnel', 'status', '--json']);
    let funnelConfig: any = null;
    if (funnelStatus.ok && funnelStatus.stdout.trim()) {
      try {
        funnelConfig = JSON.parse(funnelStatus.stdout);
      } catch {}
    }

    const hostKey = `${publicUrl.hostname}:443`;
    const expectedProxy = `http://127.0.0.1:${port}`;
    const actualProxy = funnelConfig?.Web?.[hostKey]?.Handlers?.['/']?.Proxy;
    const allowed = funnelConfig?.AllowFunnel?.[hostKey] === true;

    if (actualProxy !== expectedProxy || !allowed) {
      const repair = runTailscale(['funnel', '--bg', '--yes', String(port)]);
      if (repair.ok) {
        await appendSupervisor(
          `tailscale funnel repaired host=${publicUrl.hostname} proxy=${expectedProxy}`
        );
      } else {
        await appendSupervisor(
          `tailscale funnel repair failed: ${repair.stderr.trim() || repair.stdout.trim()}`
        );
      }
    }
  } catch (error) {
    await appendSupervisor(
      `tailscale auto-heal error: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    tailscaleCheckRunning = false;
  }
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
  if (tailscaleTimer) {
    clearInterval(tailscaleTimer);
    tailscaleTimer = null;
  }
  await appendSupervisor(`shutdown requested signal=${signal}`);
  await stopChildren();
  await releaseLock();
}

async function main(): Promise<void> {
  await acquireLock();
  await appendSupervisor(`supervisor started pid=${process.pid}`);
  startManaged('gateway');
  startManaged('device');
  startManaged('dashboard');
  const runtime = await loadRuntimeConfig();
  if (runtime.publicBaseUrl) startManaged('public-proxy');

  setTimeout(() => void ensureTailscaleFunnel(), 2_000);
  tailscaleTimer = setInterval(() => {
    void ensureTailscaleFunnel();
  }, 60_000);
  tailscaleTimer.unref();

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
