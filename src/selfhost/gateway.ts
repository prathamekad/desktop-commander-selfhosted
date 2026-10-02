import crypto from 'crypto';
import fs from 'fs/promises';
import http, { IncomingMessage, ServerResponse } from 'http';
import os from 'os';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadGatewaySecrets } from './credentials.js';
import { OAuthRequestError, PersonalOAuth } from './oauth.js';
import {
  assertRemoteToolPolicy,
  isPidControlledTool,
  isRemoteToolVisible,
  RemotePolicyError,
  wrapPowerShellCommand
} from './policy.js';
import { loadRuntimeConfig } from './runtime-config.js';
import {
  parseUsageLimit,
  parseUsageRange,
  UsageAnalyticsService
} from './usage-analytics.js';
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
  client: string;
}

function extractStartedPid(result: unknown): number | null {
  try {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    const match = /Process started with PID (-?\d+)/i.exec(text);
    if (!match) return null;
    const pid = Number(match[1]);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

class PersonalRouter {
  private devices = new Map<string, DeviceState>();
  private pending = new Map<string, TrackedCall>();
  private ownedPids = new Map<string, Set<number>>();
  private auditWrite: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(
    private readonly auditPath: string,
    private readonly allowedRoots: string[]
  ) {}

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
        client: prior.client ?? 'unknown',
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
        client: tracked.client,
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
        if (!isRemoteToolVisible(tool.name)) continue;
        if (!unique.has(tool.name)) unique.set(tool.name, this.withDeviceSelector(tool));
      }
    }
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async auditGatewayTool(toolName: string, ok: boolean, fields: Record<string, unknown> = {}): Promise<void> {
    await this.audit('gateway_tool', { toolName, ok, ...fields });
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
  async routeTool(
    toolName: string,
    rawArgs: Record<string, unknown>,
    client = 'unknown'
  ): Promise<unknown> {
    if (this.closing) throw new Error('Gateway is shutting down and is not accepting new tool calls');
    const args = { ...rawArgs };
    const requestedDevice = typeof args.deviceId === 'string' ? args.deviceId : undefined;
    delete args.deviceId;
    const state = this.selectDevice(toolName, requestedDevice);

    try {
      assertRemoteToolPolicy(toolName, args, this.allowedRoots);
      if (isPidControlledTool(toolName)) {
        const pid = typeof args.pid === 'number' ? args.pid : NaN;
        if (!Number.isInteger(pid) || !this.ownedPids.get(state.registration.deviceId)?.has(pid)) {
          throw new RemotePolicyError(
            `PID ${String(args.pid)} is not owned by this remote MCP session.`,
            'pid_not_owned'
          );
        }
      }
    } catch (error) {
      const reason = error instanceof RemotePolicyError ? error.reason : 'policy_error';
      await this.audit('tool_rejected_policy', {
        deviceId: state.registration.deviceId,
        toolName,
        client,
        reason
      });
      throw error;
    }

    if (toolName === 'start_process' && typeof args.command === 'string') {
      args.command = wrapPowerShellCommand(args.command, this.allowedRoots);
    }

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
          toolName,
          client
        });
      }, timeoutMs);

      this.pending.set(callId, {
        call,
        resolve,
        reject,
        timeout,
        startedMs: Date.now(),
        client
      });
      this.enqueue(state, call);
      void this.audit('tool_dispatched', {
        callId,
        deviceId: call.deviceId,
        toolName,
        client
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

    if (result.ok) {
      if (tracked.call.toolName === 'start_process') {
        const pid = extractStartedPid(result.result);
        if (pid !== null) {
          const owned = this.ownedPids.get(result.deviceId) ?? new Set<number>();
          owned.add(pid);
          this.ownedPids.set(result.deviceId, owned);
        }
      }
      if (tracked.call.toolName === 'kill_process' || tracked.call.toolName === 'force_terminate') {
        const pid = tracked.call.args.pid;
        if (typeof pid === 'number') this.ownedPids.get(result.deviceId)?.delete(pid);
      }
      if (result.result && typeof result.result === 'object' && !Array.isArray(result.result)) {
        const sanitizedResult = { ...(result.result as Record<string, unknown>) };
        delete sanitizedResult._meta;
        delete sanitizedResult.structuredContent;
        tracked.resolve(sanitizedResult);
      } else {
        tracked.resolve(result.result);
      }
    } else {
      tracked.reject(new Error(result.error || 'Device reported tool failure'));
    }

    void this.audit('tool_completed', {
      callId: result.callId,
      deviceId: result.deviceId,
      toolName: tracked.call.toolName,
      client: tracked.client,
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
    const securitySchemes = [{ type: 'oauth2', scopes: ['mcp:tools'] }];

    return {
      ...tool,
      inputSchema: schema,
      securitySchemes,
      _meta: {
        securitySchemes
      }
    };
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

function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

function tokenMatches(header: string | string[] | undefined, expected: string): boolean {
  const token = bearerToken(header);
  if (!token) return false;
  const actual = Buffer.from(token);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

function authorized(req: IncomingMessage, expected: string | undefined, allowNoAuth = false): boolean {
  return allowNoAuth || (!!expected && tokenMatches(req.headers.authorization, expected));
}

interface McpAuthorization {
  authorized: boolean;
  client: string;
}

function authorizedMcp(
  req: IncomingMessage,
  ownerToken: string | undefined,
  oauth: PersonalOAuth | null,
  allowNoAuth: boolean
): McpAuthorization {
  if (allowNoAuth) return { authorized: true, client: 'local-noauth' };
  if (ownerToken && tokenMatches(req.headers.authorization, ownerToken)) {
    return { authorized: true, client: 'local-owner' };
  }
  const token = bearerToken(req.headers.authorization);
  const payload = token ? oauth?.verifyAccessToken(token) : null;
  return {
    authorized: Boolean(payload),
    client: payload?.connector ?? 'unknown-oauth'
  };
}
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...extraHeaders
  });
  res.end(payload);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, {
    location,
    'cache-control': 'no-store'
  });
  res.end();
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
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
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<any> {
  const raw = await readBody(req, maxBytes);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error: any = new Error('invalid JSON body');
    error.status = 400;
    throw error;
  }
}

async function readForm(req: IncomingMessage, maxBytes: number): Promise<URLSearchParams> {
  const raw = await readBody(req, maxBytes);
  return new URLSearchParams(raw);
}

function parsePollTimeout(value: unknown): number {
  const parsed = Number(value ?? 25_000);
  if (!Number.isFinite(parsed)) return 25_000;
  return Math.max(1_000, Math.min(parsed, 30_000));
}

function isLoopback(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}
function createMcpServer(router: PersonalRouter, client: string): Server {
  const server = new Server(
    { name: 'setu', version: '1.0.1' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'selfhost_list_devices',
        description: 'List personal devices registered with SETU, your private self-hosted MCP gateway.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        securitySchemes: [{ type: 'oauth2', scopes: ['mcp:tools'] }],
        _meta: {
          securitySchemes: [{ type: 'oauth2', scopes: ['mcp:tools'] }]
        }
      },
      ...router.listTools()
    ] as any
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === 'selfhost_list_devices') {
        const devices = router.listDevices();
        await router.auditGatewayTool('selfhost_list_devices', true, {
          deviceCount: devices.length,
          client
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(devices, null, 2) }]
        };
      }
      return await router.routeTool(name, args, client) as any;
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
  const runtimeConfig = await loadRuntimeConfig();
  const host = process.env.SELFHOST_HOST ?? runtimeConfig.host ?? '127.0.0.1';
  const port = Number(process.env.SELFHOST_PORT ?? runtimeConfig.port ?? 8787);
  const savedSecrets = await loadGatewaySecrets();
  const ownerToken = process.env.SELFHOST_OWNER_TOKEN ?? savedSecrets?.ownerToken;
  const deviceToken = process.env.SELFHOST_DEVICE_TOKEN ?? savedSecrets?.deviceToken;
  const allowNoAuth = process.env.SELFHOST_ALLOW_NOAUTH === 'true';
  const maxBodyBytes = Number(process.env.SELFHOST_MAX_BODY_BYTES ?? 32 * 1024 * 1024);
  const publicBaseRaw = (process.env.SELFHOST_PUBLIC_BASE_URL ?? runtimeConfig.publicBaseUrl)?.trim();
  const publicBase = publicBaseRaw ? new URL(publicBaseRaw).origin : null;
  const oauthRedirectUris = [
    'https://claude.ai/api/mcp/auth_callback',
    ...(runtimeConfig.oauthRedirectUris ?? []),
    ...(process.env.SELFHOST_OAUTH_REDIRECT_URIS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  ].map((value) => new URL(value).toString());

  const oauth = publicBase
    && savedSecrets?.oauthClientId
    && savedSecrets?.oauthClientSecret
    && savedSecrets?.oauthSigningSecret
    ? new PersonalOAuth({
        issuer: publicBase,
        resource: `${publicBase}/mcp`,
        clientId: savedSecrets.oauthClientId,
        clientSecret: savedSecrets.oauthClientSecret,
        signingSecret: savedSecrets.oauthSigningSecret,
        redirectUris: oauthRedirectUris
      })
    : null;

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
  if (publicBaseRaw && !publicBaseRaw.startsWith('https://')) {
    throw new Error('SELFHOST_PUBLIC_BASE_URL must use https://');
  }
  if (publicBaseRaw && !oauth) {
    throw new Error('OAuth secrets are missing. Run npm run selfhost:init before enabling SELFHOST_PUBLIC_BASE_URL.');
  }

  const auditPath = process.env.SELFHOST_AUDIT_LOG
    ?? path.join(os.homedir(), '.desktop-commander-selfhosted', 'gateway-audit.jsonl');
  const envAllowedRoots = (process.env.SELFHOST_ALLOWED_ROOTS ?? '')
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedRoots = envAllowedRoots.length > 0 ? envAllowedRoots : (runtimeConfig.allowedRoots ?? []);
  if (allowedRoots.length === 0) {
    throw new Error(
      'No remote workspace roots are configured. Run: npm run selfhost:configure -- --allowed-root <path>'
    );
  }
  const router = new PersonalRouter(auditPath, allowedRoots);
  const usageAnalytics = new UsageAnalyticsService(auditPath);
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
          oauthEnabled: Boolean(oauth),
          time: nowIso(),
          devicesOnline: router.listDevices().filter((device) => device.online).length
        });
        return;
      }

      if (method === 'GET' && (
        url.pathname === '/.well-known/oauth-protected-resource'
        || url.pathname === '/.well-known/oauth-protected-resource/mcp'
      )) {
        if (!oauth) {
          sendJson(res, 404, { error: 'oauth_not_configured' });
          return;
        }
        sendJson(res, 200, oauth.protectedResourceMetadata(), {
          'access-control-allow-origin': '*'
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        if (!oauth) {
          sendJson(res, 404, { error: 'oauth_not_configured' });
          return;
        }
        sendJson(res, 200, oauth.authorizationServerMetadata(), {
          'access-control-allow-origin': '*'
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/oauth/authorize') {
        if (!oauth) {
          sendJson(res, 404, { error: 'oauth_not_configured' });
          return;
        }
        try {
          redirect(res, oauth.authorize(url.searchParams));
        } catch (error) {
          if (error instanceof OAuthRequestError) {
            sendJson(res, 400, {
              error: error.oauthError,
              error_description: error.message
            });
          } else {
            throw error;
          }
        }
        return;
      }

      if (method === 'POST' && url.pathname === '/oauth/token') {
        if (!oauth) {
          sendJson(res, 404, { error: 'oauth_not_configured' });
          return;
        }
        try {
          const form = await readForm(req, Math.min(maxBodyBytes, 64 * 1024));
          const grantType = form.get('grant_type');
          const result = grantType === 'authorization_code'
            ? oauth.exchangeAuthorizationCode(form, req.headers.authorization)
            : grantType === 'refresh_token'
              ? oauth.refresh(form, req.headers.authorization)
              : (() => { throw new OAuthRequestError('unsupported_grant_type'); })();
          sendJson(res, 200, result);
        } catch (error) {
          if (error instanceof OAuthRequestError) {
            const status = error.oauthError === 'invalid_client' ? 401 : 400;
            sendJson(res, status, {
              error: error.oauthError,
              error_description: error.message
            });
          } else {
            throw error;
          }
        }
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

      if (url.pathname.startsWith('/api/usage/')) {
        if (!authorized(req, ownerToken, allowNoAuth)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }

        const range = parseUsageRange(url.searchParams.get('range'));
        if (url.pathname === '/api/usage/summary') {
          sendJson(res, 200, await usageAnalytics.summary(range));
          return;
        }
        if (url.pathname === '/api/usage/tools') {
          const limit = parseUsageLimit(url.searchParams.get('limit'), 25);
          sendJson(res, 200, await usageAnalytics.tools(range, limit));
          return;
        }
        if (url.pathname === '/api/usage/clients') {
          sendJson(res, 200, await usageAnalytics.clients(range));
          return;
        }
        if (url.pathname === '/api/usage/activity') {
          sendJson(res, 200, await usageAnalytics.activity(range));
          return;
        }
        if (url.pathname === '/api/usage/events') {
          const limit = parseUsageLimit(url.searchParams.get('limit'), 50);
          sendJson(res, 200, await usageAnalytics.recentEvents(limit));
          return;
        }

        sendJson(res, 404, { error: 'usage_endpoint_not_found' });
        return;
      }

      if (url.pathname === '/mcp') {
        const mcpAuth = authorizedMcp(req, ownerToken, oauth, allowNoAuth);
        if (!mcpAuth.authorized) {
          const headers: Record<string, string> = {};
          if (oauth && publicBase) {
            headers['www-authenticate'] =
              `Bearer resource_metadata="${publicBase}/.well-known/oauth-protected-resource", scope="mcp:tools"`;
          }
          sendJson(res, 401, {
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unauthorized' },
            id: null
          }, headers);
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
        const server = createMcpServer(router, mcpAuth.client);
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
      console.log('SETU Gateway');
      console.log(`  MCP:     http://${host}:${port}/mcp`);
      console.log(`  Device:  http://${host}:${port}/api/device/*`);
      console.log(`  Auth:    ${allowNoAuth ? 'MCP no-auth on loopback' : oauth ? 'owner bearer + OAuth' : 'owner bearer token'}`);
      console.log(`  OAuth:   ${oauth && publicBase ? `enabled for ${publicBase}` : 'disabled (set SELFHOST_PUBLIC_BASE_URL)'}`);
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
