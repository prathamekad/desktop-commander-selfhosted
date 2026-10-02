import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { SELFHOST_DIR } from './credentials.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const supervisorPath = path.join(__dirname, 'supervisor.js');
const startupDir = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'
);
const launcherPath = path.join(startupDir, 'SETU.vbs');
const legacyLauncherPath = path.join(startupDir, 'DesktopCommanderSelfhost.vbs');
const startMenuPrograms = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs'
);
const programsDir = path.join(startMenuPrograms, 'SETU');
const legacyProgramsDir = path.join(startMenuPrograms, 'Desktop Commander Selfhost');
const controlPath = path.join(__dirname, 'control.js');
const openDashboardPath = path.join(__dirname, 'open-dashboard.js');
const lockPath = path.join(SELFHOST_DIR, 'supervisor.lock');

if (process.platform !== 'win32') {
  throw new Error('This installer is only for Windows.');
}

async function stopExisting(): Promise<void> {
  try {
    const pid = Number((await fs.readFile(lockPath, 'utf8')).trim());
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  } catch {}
}

async function remove(): Promise<void> {
  await fs.rm(launcherPath, { force: true });
  await fs.rm(legacyLauncherPath, { force: true });
  await fs.rm(programsDir, { recursive: true, force: true });
  await fs.rm(legacyProgramsDir, { recursive: true, force: true });
  await stopExisting();
  console.log('Removed SETU Windows Startup launcher and Start Menu controls.');
}

async function installStartMenuControls(): Promise<void> {
  await fs.rm(legacyProgramsDir, { recursive: true, force: true });
  await fs.mkdir(programsDir, { recursive: true });
  const actions = ['start', 'status', 'restart', 'stop'] as const;
  for (const action of actions) {
    const label = action.charAt(0).toUpperCase() + action.slice(1);
    const commandFile = path.join(programsDir, `SETU - ${label}.cmd`);
    const body = [
      '@echo off',
      `"${process.execPath}" "${controlPath}" ${action}`,
      '',
      'pause',
      ''
    ].join('\r\n');
    await fs.writeFile(commandFile, body, 'utf8');
  }

  const dashboardCommand = path.join(
    programsDir,
    'SETU - Usage Dashboard.cmd'
  );
  await fs.writeFile(
    dashboardCommand,
    [
      '@echo off',
      `"${process.execPath}" "${openDashboardPath}"`,
      ''
    ].join('\r\n'),
    'utf8'
  );
}

async function install(): Promise<void> {
  await fs.mkdir(startupDir, { recursive: true });
  await fs.rm(legacyLauncherPath, { force: true });
  const node = process.execPath.replace(/"/g, '""');
  const supervisor = supervisorPath.replace(/"/g, '""');
  const command = `"${node}" "${supervisor}"`;
  const vbs = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${command.replace(/"/g, '""')}", 0, False`
  ].join('\r\n') + '\r\n';

  await fs.writeFile(launcherPath, vbs, 'utf8');
  await installStartMenuControls();
  console.log('Installed current-user Startup launcher:');
  console.log(launcherPath);
  console.log('Installed SETU Start Menu controls under:');
  console.log(programsDir);

  await stopExisting();
  const child = spawn(process.execPath, [supervisorPath], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  child.unref();
  console.log('Started self-host supervisor in the background.');
}

if (process.argv.includes('--remove')) {
  await remove();
} else {
  await install();
}
