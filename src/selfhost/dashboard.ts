import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import http, { IncomingMessage, ServerResponse } from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadRuntimeConfig } from './runtime-config.js';
import {
  parseUsageRange,
  UsageAnalyticsService,
  UsageRange
} from './usage-analytics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSET_DIR = path.join(__dirname, 'dashboard');

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType: string,
  extraHeaders: Record<string, string> = {}
): void {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': payload.length,
    'cache-control': contentType.includes('text/html') ? 'no-store' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ...extraHeaders
  });
  res.end(payload);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

async function readAsset(name: string): Promise<Buffer> {
  return fs.readFile(path.join(ASSET_DIR, name));
}

async function fetchJson(url: string, timeoutMs = 1500): Promise<any | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function tailscaleFunnelOn(): boolean {
  if (process.platform !== 'win32') return false;
  const exe = path.join(
    process.env.ProgramFiles ?? 'C:\\Program Files',
    'Tailscale',
    'tailscale.exe'
  );
  const result = spawnSync(exe, ['funnel', 'status', '--json'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 2000
  });
  if (result.status !== 0 || !result.stdout?.trim()) return false;
  try {
    const parsed = JSON.parse(result.stdout);
    return Boolean(
      parsed?.AllowFunnel
      && Object.values(parsed.AllowFunnel).some((value) => value === true)
    );
  } catch {
    return false;
  }
}

async function dashboardStatus(
  privatePort: number,
  publicPort: number,
  publicBaseUrl?: string
): Promise<Record<string, unknown>> {
  const [gateway, publicProxy] = await Promise.all([
    fetchJson(`http://127.0.0.1:${privatePort}/healthz`),
    publicBaseUrl
      ? fetchJson(`http://127.0.0.1:${publicPort}/healthz`)
      : Promise.resolve(null)
  ]);

  return {
    homeOnline: Number(gateway?.devicesOnline ?? 0) > 0,
    devicesOnline: Number(gateway?.devicesOnline ?? 0),
    gatewayHealthy: gateway?.ok === true,
    oauthEnabled: gateway?.oauthEnabled === true,
    publicProxyHealthy: publicBaseUrl ? publicProxy?.ok === true : false,
    funnelOn: publicBaseUrl ? tailscaleFunnelOn() : false,
    publicMcpUrl: publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/mcp` : null
  };
}

export async function startDashboard(): Promise<void> {
  const runtime = await loadRuntimeConfig();
  const privatePort = runtime.port ?? 8787;
  const publicPort = runtime.publicPort ?? 8788;
  const dashboardPort = Number(process.env.SELFHOST_DASHBOARD_PORT ?? runtime.dashboardPort ?? 8790);
  const auditPath = process.env.SELFHOST_AUDIT_LOG
    ?? path.join(os.homedir(), '.desktop-commander-selfhosted', 'gateway-audit.jsonl');
  const usage = new UsageAnalyticsService(auditPath);

  if (!Number.isInteger(dashboardPort) || dashboardPort < 1 || dashboardPort > 65535) {
    throw new Error('Dashboard port must be an integer from 1 to 65535');
  }

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }

      if (url.pathname === '/' || url.pathname === '/usage') {
        send(res, 200, await readAsset('index.html'), 'text/html; charset=utf-8');
        return;
      }

      if (url.pathname === '/app.js') {
        send(res, 200, await readAsset('app.js'), 'text/javascript; charset=utf-8');
        return;
      }

      if (url.pathname === '/style.css') {
        send(res, 200, await readAsset('style.css'), 'text/css; charset=utf-8');
        return;
      }

      if (url.pathname === '/api/dashboard') {
        const range: UsageRange = parseUsageRange(url.searchParams.get('range'));
        const [summary, tools, clients, activity, events, status] = await Promise.all([
          usage.summary(range),
          usage.tools(range, 20),
          usage.clients(range),
          usage.activity('today'),
          usage.recentEvents(30),
          dashboardStatus(privatePort, publicPort, runtime.publicBaseUrl)
        ]);

        sendJson(res, 200, {
          generatedAt: new Date().toISOString(),
          range,
          summary,
          tools,
          clients,
          activity,
          events,
          status,
          selfHosted: {
            quotaLimited: false,
            message: 'No monthly SaaS call cap. Usage comes from your own MCP gateway.'
          }
        });
        return;
      }

      if (url.pathname === '/api/healthz') {
        const status = await dashboardStatus(privatePort, publicPort, runtime.publicBaseUrl);
        sendJson(res, status.gatewayHealthy ? 200 : 503, {
          ok: status.gatewayHealthy === true,
          service: 'desktop-commander-selfhosted-dashboard',
          ...status
        });
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      console.error('[dashboard] request failed:', error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_server_error' });
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(dashboardPort, '127.0.0.1', () => {
      server.off('error', onError);
      console.log('Desktop Commander Selfhost Usage Dashboard');
      console.log(`  URL:      http://127.0.0.1:${dashboardPort}/usage`);
      console.log(`  Audit:    ${auditPath}`);
      console.log('  Exposure: loopback only');
      resolve();
    });
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const invokedPath = process.argv[1]?.replace(/\\/g, '/');
if (invokedPath && (
  import.meta.url === `file:///${invokedPath}`
  || import.meta.url === `file://${invokedPath}`
)) {
  startDashboard().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
