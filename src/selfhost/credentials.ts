import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export interface GatewaySecrets {
  ownerToken: string;
  deviceToken: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthSigningSecret: string;
}

export interface DeviceSecret {
  deviceToken: string;
}

export const SELFHOST_DIR = path.join(os.homedir(), '.desktop-commander-selfhosted');
export const GATEWAY_SECRETS_PATH = path.join(SELFHOST_DIR, 'gateway-secrets.json');
export const DEVICE_SECRET_PATH = path.join(SELFHOST_DIR, 'device-secret.json');

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function loadGatewaySecrets(): Promise<GatewaySecrets | null> {
  return readJson<GatewaySecrets>(GATEWAY_SECRETS_PATH);
}

export async function loadDeviceSecret(): Promise<DeviceSecret | null> {
  return readJson<DeviceSecret>(DEVICE_SECRET_PATH);
}

export function generateSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export async function initializeSecrets(force = false): Promise<{
  gatewayPath: string;
  devicePath: string;
  created: boolean;
}> {
  await fs.mkdir(SELFHOST_DIR, { recursive: true, mode: 0o700 });

  const existingGateway = force ? null : await loadGatewaySecrets();
  const existingDevice = force ? null : await loadDeviceSecret();

  const secrets: GatewaySecrets = {
    ownerToken: existingGateway?.ownerToken ?? generateSecret(),
    deviceToken: existingGateway?.deviceToken ?? existingDevice?.deviceToken ?? generateSecret(),
    oauthClientId: existingGateway?.oauthClientId ?? `dc-selfhost-${crypto.randomBytes(12).toString('hex')}`,
    oauthClientSecret: existingGateway?.oauthClientSecret ?? generateSecret(),
    oauthSigningSecret: existingGateway?.oauthSigningSecret ?? generateSecret()
  };

  const alreadyComplete = Boolean(
    existingGateway?.ownerToken
    && existingGateway?.deviceToken
    && existingGateway?.oauthClientId
    && existingGateway?.oauthClientSecret
    && existingGateway?.oauthSigningSecret
    && existingDevice?.deviceToken === secrets.deviceToken
  );

  if (!alreadyComplete || force) {
    await atomicWrite(GATEWAY_SECRETS_PATH, secrets);
    await atomicWrite(DEVICE_SECRET_PATH, { deviceToken: secrets.deviceToken });
  }
  return {
    gatewayPath: GATEWAY_SECRETS_PATH,
    devicePath: DEVICE_SECRET_PATH,
    created: !alreadyComplete || force
  };
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  const temp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, filePath);
}
