import fs from 'fs/promises';
import path from 'path';
import { SELFHOST_DIR } from './credentials.js';

export interface SelfHostRuntimeConfig {
  publicBaseUrl?: string;
  gatewayUrl?: string;
  host?: string;
  port?: number;
  publicPort?: number;
  dashboardPort?: number;
  allowedRoots?: string[];
  oauthRedirectUris?: string[];
}

export const RUNTIME_CONFIG_PATH = path.join(SELFHOST_DIR, 'runtime.json');

export async function loadRuntimeConfig(): Promise<SelfHostRuntimeConfig> {
  try {
    const raw = await fs.readFile(RUNTIME_CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as SelfHostRuntimeConfig;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveRuntimeConfig(config: SelfHostRuntimeConfig): Promise<void> {
  await fs.mkdir(SELFHOST_DIR, { recursive: true, mode: 0o700 });
  const temp = `${RUNTIME_CONFIG_PATH}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.rename(temp, RUNTIME_CONFIG_PATH);
}
