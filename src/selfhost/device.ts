import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DesktopCommanderIntegration } from '../remote-device/desktop-commander-integration.js';
import { VERSION } from '../version.js';
import { DeviceRegistration, RoutedCall, RoutedResult } from './protocol.js';

const CONFIG_DIR = path.join(os.homedir(), '.desktop-commander-selfhosted');
const DEVICE_CONFIG = path.join(CONFIG_DIR, 'device.json');
const CALL_JOURNAL = path.join(CONFIG_DIR, 'attempted-calls.json');
const CALL_HISTORY_MAX = 2_000;

interface DeviceConfig {
  deviceId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, filePath);
}
async function resolveDeviceId(): Promise<string> {
  if (process.env.SELFHOST_DEVICE_ID) return process.env.SELFHOST_DEVICE_ID;
  try {
    const parsed = JSON.parse(await fs.readFile(DEVICE_CONFIG, 'utf8')) as DeviceConfig;
    if (parsed.deviceId) return parsed.deviceId;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.warn('[device] could not read device config:', error?.message ?? String(error));
    }
  }
  const deviceId = crypto.randomUUID();
  await atomicJsonWrite(DEVICE_CONFIG, { deviceId });
  return deviceId;
}

class AttemptJournal {
  private ids = new Set<string>();

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(CALL_JOURNAL, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const id of parsed) if (typeof id === 'string') this.ids.add(id);
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        console.warn('[device] call journal could not be read:', error?.message ?? String(error));
      }
    }
  }

  async claim(callId: string): Promise<boolean> {
    if (this.ids.has(callId)) return false;
    this.ids.add(callId);
    while (this.ids.size > CALL_HISTORY_MAX) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
    await atomicJsonWrite(CALL_JOURNAL, [...this.ids]);
    return true;
  }
}
class GatewayClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async register(registration: DeviceRegistration): Promise<void> {
    await this.post('/api/device/register', registration, 15_000);
  }

  async poll(deviceId: string): Promise<RoutedCall | null> {
    const body = await this.post('/api/device/poll', { deviceId, timeoutMs: 25_000 }, 35_000);
    return (body.call ?? null) as RoutedCall | null;
  }

  async sendResult(result: RoutedResult): Promise<'accepted' | 'gone'> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.post('/api/device/result', result, 15_000);
        return 'accepted';
      } catch (error: any) {
        if (error?.status === 404) return 'gone';
        const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
        console.warn(`[device] result delivery failed; retrying in ${delay}ms:`, error?.message ?? String(error));
        await sleep(delay);
      }
    }
  }
  private async post(endpoint: string, payload: unknown, timeoutMs: number): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const text = await response.text();
      let body: any = {};
      if (text) {
        try { body = JSON.parse(text); }
        catch { body = { error: text }; }
      }
      if (!response.ok) {
        const error: any = new Error(body.error || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}
export async function startSelfHostedDevice(): Promise<void> {
  process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

  const gatewayUrl = process.env.SELFHOST_GATEWAY_URL ?? 'http://127.0.0.1:8787';
  const token = process.env.SELFHOST_DEVICE_TOKEN;
  if (!token) throw new Error('SELFHOST_DEVICE_TOKEN is required');

  const deviceId = await resolveDeviceId();
  const deviceName = process.env.SELFHOST_DEVICE_NAME ?? os.hostname();
  const journal = new AttemptJournal();
  await journal.load();

  const desktop = new DesktopCommanderIntegration();
  await desktop.initialize();

  const client = new GatewayClient(gatewayUrl, token);
  let stopping = false;

  const register = async () => {
    await desktop.ensureReady();
    const listed = await desktop.listClientTools();
    await client.register({
      deviceId,
      deviceName,
      tools: (listed.tools ?? []) as any,
      version: VERSION
    });
    console.log(`[device] registered ${deviceName} (${deviceId}) with ${listed.tools?.length ?? 0} tools`);
  };

  await register();
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('[device] shutting down');
    await desktop.shutdown().catch(() => undefined);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  let failures = 0;
  while (!stopping) {
    try {
      const call = await client.poll(deviceId);
      failures = 0;
      if (!call) continue;

      let result: RoutedResult;
      if (!(await journal.claim(call.callId))) {
        result = {
          callId: call.callId,
          deviceId,
          ok: false,
          error: 'Duplicate delivery blocked locally; this call ID was already attempted.'
        };
      } else {
        console.log(`[device] executing ${call.toolName} (${call.callId})`);
        try {
          const value = await desktop.callClientTool(call.toolName, call.args, {
            selfhosted: true,
            gateway: 'personal'
          });
          result = { callId: call.callId, deviceId, ok: true, result: value };
        } catch (error) {
          result = {
            callId: call.callId,
            deviceId,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      }

      const delivery = await client.sendResult(result);
      if (delivery === 'gone') {
        console.warn('[device] gateway no longer knows this call; re-registering');
        await register();
      }
    } catch (error: any) {
      failures++;
      if (error?.status === 404) {
        console.warn('[device] registration missing; registering again');
        try {
          await register();
          failures = 0;
          continue;
        } catch (registerError: any) {
          console.warn('[device] registration retry failed:', registerError?.message ?? String(registerError));
        }
      }
      const delay = Math.min(10_000, 500 * 2 ** Math.min(failures, 5));
      console.warn(`[device] gateway unavailable; retrying in ${delay}ms:`, error?.message ?? String(error));
      await sleep(delay);
    }
  }
}

const invokedPath = process.argv[1]?.replace(/\\/g, '/');
if (invokedPath && (
  import.meta.url === `file:///${invokedPath}`
  || import.meta.url === `file://${invokedPath}`
)) {
  startSelfHostedDevice().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
