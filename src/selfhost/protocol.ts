export type JsonObject = Record<string, unknown>;

export interface DeviceTool {
  name: string;
  description?: string;
  inputSchema: JsonObject;
  annotations?: JsonObject;
  securitySchemes?: JsonObject[];
  _meta?: JsonObject;
}

export interface DeviceRegistration {
  deviceId: string;
  deviceName: string;
  tools: DeviceTool[];
  version?: string;
}

export interface RoutedCall {
  callId: string;
  deviceId: string;
  toolName: string;
  args: JsonObject;
  createdAt: string;
}

export interface RoutedResult {
  callId: string;
  deviceId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
export interface DeviceSnapshot {
  deviceId: string;
  deviceName: string;
  online: boolean;
  lastSeenAt: string;
  version?: string;
  toolCount: number;
}

export interface PendingCall {
  call: RoutedCall;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export const DEVICE_STALE_MS = 45_000;
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
export const MAX_CALL_TIMEOUT_MS = 600_000;

export function nowIso(): string {
  return new Date().toISOString();
}
