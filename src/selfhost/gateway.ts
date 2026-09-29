import crypto from 'crypto';
import fs from 'fs/promises';
import http, { IncomingMessage, ServerResponse } from 'http';
import os from 'os';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadGatewaySecrets } from './credentials.js';
import {
  DEFAULT_CALL_TIMEOUT_MS,
  DEVICE_STALE_MS,
  DeviceRegistration,
  DeviceSnapshot,
  DeviceTool,
  MAX_CALL_TIMEOUT_MS,
  PendingCall,
  RoutedCall,
  RoutedResult,
  nowIso
} from './protocol.js';

interface DeviceState {
  registration: DeviceRegistration;
  lastSeenMs: number;
  queue: RoutedCall[];
  inFlight: Map<string, { call: RoutedCall; leasedAtMs: number }>;
  pollWaiter?: (call: RoutedCall | null) => void;
}

interface TrackedCall extends PendingCall {
  startedMs: number;
}
class PersonalRouter {
  private devices = new Map<string, DeviceState>();
  private pending = new Map<string, TrackedCall>();
  private auditWrite: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(private readonly auditPath: string) {}

  get acceptingCalls(): boolean {
    return !this.closing;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.auditPath), { recursive: true });
    let contents = '';
    try {
      contents = await fs.readFile(this.auditPath, 'utf8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    const unresolved = new Map<string, Record<string, unknown>>();
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const callId = typeof event.callId === 'string' ? event.callId : undefined;
        if (!callId) continue;
        if (event.event === 'tool_dispatched') unresolved.set(callId, event);
        if (['tool_completed', 'tool_timeout', 'tool_abandoned_shutdown', 'tool_abandoned_restart'].includes(event.event)) {
          unresolved.delete(callId);
        }
      } catch {
        // A partially written final audit line must not stop startup.
      }
    }

    for (const [callId, prior] of unresolved) {
      await this.audit('tool_abandoned_restart', {
        callId,
        deviceId: prior.deviceId ?? null,
        toolName: prior.toolName ?? null,
        reason: 'gateway_restarted_before_terminal_receipt'
      });
    }
  }

  async shutdown(reason: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    for (const state of this.devices.values()) {
      const waiter = state.pollWaiter;
      delete state.pollWaiter;
      waiter?.(null);
    }

    for (const [callId, tracked] of [...this.pending]) {
      this.pending.delete(callId);
      clearTimeout(tracked.timeout);
      const state = this.devices.get(tracked.call.deviceId);
      state?.inFlight.delete(callId);
      tracked.reject(new Error(
        'Gateway is shutting down; execution state is unknown. Do not blindly retry side-effecting tools.'
      ));
      await this.audit('tool_abandoned_shutdown', {
        callId,
        deviceId: tracked.call.deviceId,
        toolName: tracked.call.toolName,
        reason
      });
    }

    await this.auditWrite;
  }

  register(registration: DeviceRegistration): DeviceSnapshot {
    if (this.closing) throw new Error('Gateway is shutting down');
    const prior = this.devices.get(registration.deviceId);
    this.devices.set(registration.deviceId, {
      registration,
      lastSeenMs: Date.now(),
      queue: prior?.queue ?? [],
      inFlight: prior?.inFlight ?? new Map(),
      pollWaiter: prior?.pollWaiter
    });
    void this.audit('device_registered', {
      deviceId: registration.deviceId,
      deviceName: registration.deviceName,
      toolCount: registration.tools.length,
      version: registration.version ?? null
    });
    return this.snapshot(registration.deviceId)!;
  }

  snapshot(deviceId: string): DeviceSnapshot | undefined {
    const state = this.devices.get(deviceId);
    if (!state) return undefined;
    return {
      deviceId,
      deviceName: state.registration.deviceName,
      online: this.isOnline(state),
      lastSeenAt: new Date(state.lastSeenMs).toISOString(),
      version: state.registration.version,
      toolCount: state.registration.tools.length
    };
  }

  listDevices(): DeviceSnapshot[] {
    return [...this.devices.keys()]
      .map((id) => this.snapshot(id)!)
      .sort((a, b) => a.deviceName.localeCompare(b.deviceName));
  }
  listTools(): DeviceTool[] {
    const unique = new Map<string, DeviceTool>();
    for (const state of this.onlineStates()) {
      for (const tool of state.registration.tools) {
        if (!unique.has(tool.name)) unique.set(tool.name, this.withDeviceSelector(tool));
      }
    }
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async poll(deviceId: string, timeoutMs: number): Promise<RoutedCall | null> {
    if (this.closing) return null;
    const state = this.devices.get(deviceId);
    if (!state) throw new Error('Device is not registered');
    state.lastSeenMs = Date.now();

    const configuredLease = Number(process.env.SELFHOST_DELIVERY_LEASE_MS ?? 45_000);
    const leaseMs = Number.isFinite(configuredLease) && configuredLease > 0
      ? configuredLease
      : 45_000;
    const expired = [...state.inFlight.values()]
      .find((entry) => Date.now() - entry.leasedAtMs >= leaseMs);
    if (expired) {
      expired.leasedAtMs = Date.now();
      return expired.call;
    }

    const queued = state.queue.shift();
    if (queued) {
      state.inFlight.set(queued.callId, { call: queued, leasedAtMs: Date.now() });
      return queued;
    }

    return new Promise<RoutedCall | null>((resolve) => {
      let settled = false;
      const finish = (call: RoutedCall | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (state.pollWaiter === finish) delete state.pollWaiter;
        resolve(call);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      state.pollWaiter = finish;
    });
  }
  async routeTool(toolName: string, rawArgs: Record<string, unknown>): Promise<unknown> {
    if (this.closing) throw new Error('Gateway is shutting down and is not accepting new tool calls');
    const args = { ...rawArgs };
    const requestedDevice = typeof args.deviceId === 'string' ? args.deviceId : undefined;
    delete args.deviceId;
    const state = this.selectDevice(toolName, requestedDevice);
    const callId = crypto.randomUUID();
    const call: RoutedCall = {
      callId,
      deviceId: state.registration.deviceId,
      toolName,
      args,
      createdAt: nowIso()
    };

    return new Promise((resolve, reject) => {
      const timeoutMs = this.callTimeoutMs();
      const timeout = setTimeout(() => {
        this.pending.delete(callId);
        const device = this.devices.get(call.deviceId);
        device?.inFlight.delete(callId);
        if (device) device.queue = device.queue.filter((queued) => queued.callId !== callId);
        reject(new Error(`Tool call timed out after ${timeoutMs}ms`));
        void this.audit('tool_timeout', {
          callId,
          deviceId: call.deviceId,
          toolName
        });
      }, timeoutMs);

      this.pending.set(callId, { call, resolve, reject, timeout, startedMs: Date.now() });
      this.enqueue(state, call);
      void this.audit('tool_dispatched', {
        callId,
        deviceId: call.deviceId,
        toolName
      });
    });
  }

  complete(result: RoutedResult): boolean {
    const tracked = this.pending.get(result.callId);
    if (!tracked || tracked.call.deviceId !== result.deviceId) return false;
    this.pending.delete(result.callId);
    clearTimeout(tracked.timeout);
    this.devices.get(result.deviceId)?.inFlight.delete(result.callId);
    const durationMs = Date.now() - tracked.startedMs;

    if (result.ok) tracked.resolve(result.result);
    else tracked.reject(new Error(result.error || 'Device reported tool failure'));

    void this.audit('tool_completed', {
      callId: result.callId,
      deviceId: result.deviceId,
      toolName: tracked.call.toolName,
      ok: result.ok,
      durationMs
    });
    return true;
  }
  private enqueue(state: DeviceState, call: RoutedCall): void {
    state.lastSeenMs = Date.now();
    if (state.pollWaiter) {
      const waiter = state.pollWaiter;
      delete state.pollWaiter;
      state.inFlight.set(call.callId, { call, leasedAtMs: Date.now() });
      waiter(call);
      return;
    }
    state.queue.push(call);
  }

  private selectDevice(toolName: string, requested?: string): DeviceState {
    const candidates = this.onlineStates().filter((state) =>
      state.registration.tools.some((tool) => tool.name === toolName)
    );
    if (requested) {
      const selected = candidates.find((state) => state.registration.deviceId === requested);
      if (!selected) throw new Error(`Device '${requested}' is offline or does not expose '${toolName}'`);
      return selected;
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) throw new Error(`No online device exposes '${toolName}'`);
    const names = candidates.map((state) =>
      `${state.registration.deviceName} (${state.registration.deviceId})`
    );
    throw new Error(`Multiple devices are online. Pass deviceId. Available: ${names.join(', ')}`);
  }

  private onlineStates(): DeviceState[] {
    return [...this.devices.values()].filter((state) => this.isOnline(state));
  }

  private isOnline(state: DeviceState): boolean {
    return Date.now() - state.lastSeenMs <= DEVICE_STALE_MS;
  }
  private withDeviceSelector(tool: DeviceTool): DeviceTool {
    const schema = JSON.parse(JSON.stringify(tool.inputSchema ?? { type: 'object' }));
    if (schema.type === 'object') {
      schema.properties = {
        ...(schema.properties ?? {}),
        deviceId: {
          type: 'string',
          description: 'Optional personal device ID. Required when multiple matching devices are online.'
        }
      };
    }
    return { ...tool, inputSchema: schema };
  }

  private callTimeoutMs(): number {
    const parsed = Number(process.env.SELFHOST_CALL_TIMEOUT_MS ?? DEFAULT_CALL_TIMEOUT_MS);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CALL_TIMEOUT_MS;
    return Math.min(parsed, MAX_CALL_TIMEOUT_MS);
  }

  private async audit(event: string, fields: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ ts: nowIso(), event, ...fields }) + os.EOL;
    this.auditWrite = this.auditWrite.then(async () => {
      await fs.mkdir(path.dirname(this.auditPath), { recursive: true });
      await fs.appendFile(this.auditPath, line, 'utf8');
    }).catch((error) => {
      console.error('[audit] write failed:', error instanceof Error ? error.message : String(error));
    });
    await this.auditWrite;
  }
}

function tokenMatches(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const actual = Buffer.from(match[1]);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

function authorized(req: IncomingMessage, expected: string | undefined, allowNoAuth = false): boolean {
  return allowNoAuth || (!!expected && tokenMatches(req.headers.authorization, expected));
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': payload.length,
    'cache-control': 'no-store'
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error: any = new Error('request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error: any = new Error('invalid JSON body');
    error.status = 400;
    throw error;
  }
}

function parsePollTimeout(value: unknown): number {
  const parsed = Number(value ?? 25_000);
  if (!Number.isFinite(parsed)) return 25_000;
  return Math.max(1_000, Math.min(parsed, 30_000));
}

function isLoopback(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}
function createMcpServer(router: PersonalRouter): Server {
  const server = new Server(
    { name: 'desktop-commander-selfhosted', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'selfhost_list_devices',
        description: 'List personal devices registered with this self-hosted Desktop Commander gateway.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true }
      },
      ...router.listTools()
    ] as any
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === 'selfhost_list_devices') {
        return {
          content: [{ type: 'text', text: JSON.stringify(router.listDevices(), null, 2) }]
        };
      }
      return await router.routeTool(name, args) as any;
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: error instanceof Error ? error.message : String(error)
        }]
      };
    }
  });

  return server;
}

export async function startGateway(): Promise<void> {
  const host = process.env.SELFHOST_HOST ?? '127.0.0.1';
  const port = Number(process.env.SELFHOST_PORT ?? 8787);
  const savedSecrets = await loadGatewaySecrets();
  const ownerToken = process.env.SELFHOST_OWNER_TOKEN ?? savedSecrets?.ownerToken;
  const deviceToken = process.env.SELFHOST_DEVICE_TOKEN ?? savedSecrets?.deviceToken;
  const allowNoAuth = process.env.SELFHOST_ALLOW_NOAUTH === 'true';
  const maxBodyBytes = Number(process.env.SELFHOST_MAX_BODY_BYTES ?? 32 * 1024 * 1024);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SELFHOST_PORT must be an integer from 1 to 65535');
  }
  if (!Number.isFinite(maxBodyBytes) || maxBodyBytes < 1024) {
    throw new Error('SELFHOST_MAX_BODY_BYTES must be at least 1024');
  }
  if (!deviceToken) throw new Error('SELFHOST_DEVICE_TOKEN is required');
  if (!ownerToken && !allowNoAuth) {
    throw new Error('Set SELFHOST_OWNER_TOKEN or explicitly set SELFHOST_ALLOW_NOAUTH=true');
  }
  if (allowNoAuth && !isLoopback(host)) {
    throw new Error('Unauthenticated MCP is allowed only on loopback');
  }

  const auditPath = process.env.SELFHOST_AUDIT_LOG
    ?? path.join(os.homedir(), '.desktop-commander-selfhosted', 'gateway-audit.jsonl');
  const router = new PersonalRouter(auditPath);
  await router.initialize();
  let shuttingDown = false;

  const listener = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, router.acceptingCalls ? 200 : 503, {
          ok: router.acceptingCalls,
          acceptingCalls: router.acceptingCalls,
          service: 'desktop-commander-selfhosted',
          time: nowIso(),
          devicesOnline: router.listDevices().filter((device) => device.online).length
        });
        return;
      }

      if (url.pathname.startsWith('/api/device/') && !authorized(req, deviceToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/device/register') {
        const body = await readJson(req, maxBodyBytes) as Partial<DeviceRegistration>;
        if (!body.deviceId || !body.deviceName || !Array.isArray(body.tools)) {
          sendJson(res, 400, { error: 'deviceId, deviceName and tools are required' });
          return;
        }
        sendJson(res, 200, { ok: true, device: router.register(body as DeviceRegistration) });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/device/poll') {
        const body = await readJson(req, maxBodyBytes);
        const deviceId = String(body?.deviceId ?? '');
        if (!deviceId) {
          sendJson(res, 400, { error: 'deviceId is required' });
          return;
        }
        try {
          const call = await router.poll(deviceId, parsePollTimeout(body?.timeoutMs));
          sendJson(res, 200, { call });
        } catch (error) {
          sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (method === 'POST' && url.pathname === '/api/device/result') {
        const result = await readJson(req, maxBodyBytes) as RoutedResult;
        if (!result?.callId || !result?.deviceId || typeof result.ok !== 'boolean') {
          sendJson(res, 400, { error: 'callId, deviceId and ok are required' });
          return;
        }
        if (!router.complete(result)) {
          sendJson(res, 404, { error: 'call not found or device mismatch' });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/api/devices') {
        if (!authorized(req, ownerToken, allowNoAuth)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        sendJson(res, 200, { devices: router.listDevices() });
        return;
      }
      if (url.pathname === '/mcp') {
        if (!authorized(req, ownerToken, allowNoAuth)) {
          sendJson(res, 401, {
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unauthorized' },
            id: null
          });
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed' },
            id: null
          });
          return;
        }

        const body = await readJson(req, maxBodyBytes);
        const server = createMcpServer(router);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error: any) {
      console.error('[gateway] request failed:', error?.message ?? String(error));
      if (!res.headersSent) {
        sendJson(res, error?.status ?? 500, { error: error?.message ?? 'internal server error' });
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    listener.once('error', onError);
    listener.listen(port, host, () => {
      listener.off('error', onError);
      console.log('Desktop Commander Self-Hosted Gateway');
      console.log(`  MCP:     http://${host}:${port}/mcp`);
      console.log(`  Device:  http://${host}:${port}/api/device/*`);
      console.log(`  Auth:    ${allowNoAuth ? 'MCP no-auth on loopback' : 'MCP bearer token'}`);
      console.log('  Quotas:  none');
      console.log(`  Audit:   ${auditPath}`);
      resolve();
    });
  });

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[gateway] ${signal} received; refusing new work and draining requests`);
    await router.shutdown(signal);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    console.log('[gateway] shutdown complete');
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT').finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').finally(() => process.exit(0));
  });
}
const invokedPath = process.argv[1]?.replace(/\\/g, '/');
if (invokedPath && (
  import.meta.url === `file:///${invokedPath}`
  || import.meta.url === `file://${invokedPath}`
)) {
  startGateway().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
