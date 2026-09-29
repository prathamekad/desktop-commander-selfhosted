import { spawn, spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SELFHOST_DIR } from './credentials.js';
import { loadRuntimeConfig } from './runtime-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const supervisorPath = path.join(__dirname, 'supervisor.js');
const lockPath = path.join(SELFHOST_DIR, 'supervisor.lock');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function supervisorPid(): Promise<number | null> {
  try {
    const pid = Number((await fs.readFile(lockPath, 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function start(): Promise<void> {
  const existing = await supervisorPid();
  if (existing) {
    console.log(`Already running (supervisor PID ${existing}).`);
    return;
  }

  const child = spawn(process.execPath, [supervisorPath], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  child.unref();

  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const pid = await supervisorPid();
    if (pid) {
      console.log(`Started (supervisor PID ${pid}).`);
      return;
    }
  }
  throw new Error('Supervisor did not start within 5 seconds.');
}

async function stop(): Promise<void> {
  const pid = await supervisorPid();
  if (!pid) {
    console.log('Already stopped.');
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {}

  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!(await supervisorPid())) {
      console.log('Stopped.');
      return;
    }
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
  }
  console.log('Stopped (forced after graceful timeout).');
}
async function status(): Promise<void> {
  const runtime = await loadRuntimeConfig();
  const pid = await supervisorPid();
  const localBase = `http://127.0.0.1:${runtime.port ?? 8787}`;

  console.log('Desktop Commander Selfhost');
  console.log(`Supervisor:  ${pid ? `RUNNING (PID ${pid})` : 'STOPPED'}`);
  console.log(`Workspace:   ${runtime.allowedRoots?.join(', ') || 'NOT CONFIGURED'}`);
  console.log(`Public MCP:  ${runtime.publicBaseUrl ? runtime.publicBaseUrl + '/mcp' : 'NOT CONFIGURED'}`);

  try {
    const response = await fetch(`${localBase}/healthz`, { signal: AbortSignal.timeout(2_000) });
    const health: any = await response.json();
    console.log(`Gateway:     ${response.ok && health.ok ? 'HEALTHY' : 'UNHEALTHY'}`);
    console.log(`Devices:     ${health.devicesOnline ?? 0} online`);
    console.log(`OAuth:       ${health.oauthEnabled ? 'enabled' : 'disabled'}`);
  } catch {
    console.log('Gateway:     UNREACHABLE');
  }

  if (process.platform === 'win32') {
    const exe = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
    const result = spawnSync(exe, ['funnel', 'status'], {
      windowsHide: true,
      encoding: 'utf8'
    });
    const funnelText = (result.stdout ?? '').trim();
    console.log(`Funnel:      ${result.status === 0 && funnelText.includes('Funnel on') ? 'ON' : 'OFF/UNAVAILABLE'}`);
  }
}

const command = (process.argv[2] ?? 'status').toLowerCase();

try {
  if (command === 'start') await start();
  else if (command === 'stop') await stop();
  else if (command === 'restart') {
    await stop();
    await start();
  } else if (command === 'status') await status();
  else throw new Error('Usage: control.js [start|status|restart|stop]');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
