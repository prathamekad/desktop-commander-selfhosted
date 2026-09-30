import { spawn } from 'child_process';
import { loadRuntimeConfig } from './runtime-config.js';

const runtime = await loadRuntimeConfig();
const url = `http://127.0.0.1:${runtime.dashboardPort ?? 8790}/usage`;

if (process.platform === 'win32') {
  const child = spawn('cmd.exe', ['/c', 'start', '', url], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  child.unref();
  console.log(`Opened ${url}`);
} else {
  console.log(url);
}
