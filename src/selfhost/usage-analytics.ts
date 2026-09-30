import fs from 'fs';
import { promises as fsp } from 'fs';
import readline from 'readline';

export type UsageRange = 'today' | 'month' | 'all';

export interface UsageCounters {
  totalCalls: number;
  successfulRouted: number;
  successfulGatewayLocal: number;
  failedRouted: number;
  failedGatewayLocal: number;
  policyRejected: number;
  timeouts: number;
  abandonedUnknown: number;
  successfulCalls: number;
  failedCalls: number;
  successRate: number;
  routedDurationMsTotal: number;
  routedDurationSamples: number;
  averageRoutedDurationMs: number | null;
}

export interface ToolUsageRow {
  toolName: string;
  calls: number;
  successful: number;
  failed: number;
  routed: number;
  gatewayLocal: number;
}

export interface ClientUsageRow {
  client: string;
  calls: number;
  successful: number;
  failed: number;
  routed: number;
  gatewayLocal: number;
}

export interface HourBucket {
  hour: number;
  label: string;
  calls: number;
  successful: number;
  failed: number;
}

export interface RecentUsageEvent {
  ts: string;
  toolName: string;
  client: string;
  outcome: 'success' | 'failed' | 'rejected' | 'timeout' | 'abandoned';
  callType: 'routed-device' | 'gateway-local';
  deviceId?: string;
  deviceName?: string;
  callId?: string;
  durationMs?: number;
  reason?: string;
}

interface MutableCounters {
  totalCalls: number;
  successfulRouted: number;
  successfulGatewayLocal: number;
  failedRouted: number;
  failedGatewayLocal: number;
  policyRejected: number;
  timeouts: number;
  abandonedUnknown: number;
  routedDurationMsTotal: number;
  routedDurationSamples: number;
}

interface MutableToolUsage {
  calls: number;
  successful: number;
  failed: number;
  routed: number;
  gatewayLocal: number;
}

interface DayAggregate {
  counters: MutableCounters;
  tools: Map<string, MutableToolUsage>;
  clients: Map<string, MutableToolUsage>;
  hours: Map<number, { calls: number; successful: number; failed: number }>;
}

interface UsageSnapshot {
  generatedAt: string;
  sourceMtimeMs: number;
  sourceSize: number;
  malformedLines: number;
  timezone: string;
  all: DayAggregate;
  days: Map<string, DayAggregate>;
  recentEvents: RecentUsageEvent[];
}

const RECENT_EVENT_LIMIT = 250;

function emptyCounters(): MutableCounters {
  return {
    totalCalls: 0,
    successfulRouted: 0,
    successfulGatewayLocal: 0,
    failedRouted: 0,
    failedGatewayLocal: 0,
    policyRejected: 0,
    timeouts: 0,
    abandonedUnknown: 0,
    routedDurationMsTotal: 0,
    routedDurationSamples: 0
  };
}

function emptyAggregate(): DayAggregate {
  return {
    counters: emptyCounters(),
    tools: new Map(),
    clients: new Map(),
    hours: new Map()
  };
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localMonthKey(date: Date): string {
  return localDayKey(date).slice(0, 7);
}

function validDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function getUsageRow(map: Map<string, MutableToolUsage>, key: string): MutableToolUsage {
  const existing = map.get(key);
  if (existing) return existing;
  const created: MutableToolUsage = {
    calls: 0,
    successful: 0,
    failed: 0,
    routed: 0,
    gatewayLocal: 0
  };
  map.set(key, created);
  return created;
}

function getTool(aggregate: DayAggregate, toolName: string): MutableToolUsage {
  return getUsageRow(aggregate.tools, toolName);
}

function getClient(aggregate: DayAggregate, client: string): MutableToolUsage {
  return getUsageRow(aggregate.clients, client);
}

function recordHour(
  aggregate: DayAggregate,
  hour: number,
  successful: boolean
): void {
  const bucket = aggregate.hours.get(hour) ?? { calls: 0, successful: 0, failed: 0 };
  bucket.calls++;
  if (successful) bucket.successful++;
  else bucket.failed++;
  aggregate.hours.set(hour, bucket);
}

function normalizeCounters(counters: MutableCounters): UsageCounters {
  const successfulCalls = counters.successfulRouted + counters.successfulGatewayLocal;
  const failedCalls =
    counters.failedRouted
    + counters.failedGatewayLocal
    + counters.policyRejected
    + counters.timeouts
    + counters.abandonedUnknown;
  const totalCalls = counters.totalCalls;
  return {
    ...counters,
    successfulCalls,
    failedCalls,
    successRate: totalCalls === 0 ? 100 : Number(((successfulCalls / totalCalls) * 100).toFixed(2)),
    averageRoutedDurationMs:
      counters.routedDurationSamples === 0
        ? null
        : Math.round(counters.routedDurationMsTotal / counters.routedDurationSamples)
  };
}

function mergeAggregate(target: DayAggregate, source: DayAggregate): void {
  const tc = target.counters;
  const sc = source.counters;
  tc.totalCalls += sc.totalCalls;
  tc.successfulRouted += sc.successfulRouted;
  tc.successfulGatewayLocal += sc.successfulGatewayLocal;
  tc.failedRouted += sc.failedRouted;
  tc.failedGatewayLocal += sc.failedGatewayLocal;
  tc.policyRejected += sc.policyRejected;
  tc.timeouts += sc.timeouts;
  tc.abandonedUnknown += sc.abandonedUnknown;
  tc.routedDurationMsTotal += sc.routedDurationMsTotal;
  tc.routedDurationSamples += sc.routedDurationSamples;

  for (const [toolName, row] of source.tools) {
    const dest = getTool(target, toolName);
    dest.calls += row.calls;
    dest.successful += row.successful;
    dest.failed += row.failed;
    dest.routed += row.routed;
    dest.gatewayLocal += row.gatewayLocal;
  }

  for (const [client, row] of source.clients) {
    const dest = getClient(target, client);
    dest.calls += row.calls;
    dest.successful += row.successful;
    dest.failed += row.failed;
    dest.routed += row.routed;
    dest.gatewayLocal += row.gatewayLocal;
  }

  for (const [hour, row] of source.hours) {
    const dest = target.hours.get(hour) ?? { calls: 0, successful: 0, failed: 0 };
    dest.calls += row.calls;
    dest.successful += row.successful;
    dest.failed += row.failed;
    target.hours.set(hour, dest);
  }
}

function addTerminalEvent(
  aggregate: DayAggregate,
  toolName: string,
  client: string,
  successful: boolean,
  callType: RecentUsageEvent['callType'],
  eventType: RecentUsageEvent['outcome'],
  durationMs?: number
): void {
  aggregate.counters.totalCalls++;
  const tool = getTool(aggregate, toolName);
  const clientRow = getClient(aggregate, client);
  tool.calls++;
  clientRow.calls++;

  if (callType === 'gateway-local') {
    tool.gatewayLocal++;
    clientRow.gatewayLocal++;
  } else {
    tool.routed++;
    clientRow.routed++;
  }

  if (successful) {
    tool.successful++;
    clientRow.successful++;
  } else {
    tool.failed++;
    clientRow.failed++;
  }

  if (callType === 'gateway-local') {
    if (successful) aggregate.counters.successfulGatewayLocal++;
    else aggregate.counters.failedGatewayLocal++;
  } else if (eventType === 'success') {
    aggregate.counters.successfulRouted++;
  } else if (eventType === 'failed') {
    aggregate.counters.failedRouted++;
  } else if (eventType === 'rejected') {
    aggregate.counters.policyRejected++;
  } else if (eventType === 'timeout') {
    aggregate.counters.timeouts++;
  } else if (eventType === 'abandoned') {
    aggregate.counters.abandonedUnknown++;
  }

  if (
    callType === 'routed-device'
    && typeof durationMs === 'number'
    && Number.isFinite(durationMs)
    && durationMs >= 0
  ) {
    aggregate.counters.routedDurationMsTotal += durationMs;
    aggregate.counters.routedDurationSamples++;
  }
}
function eventFromAudit(
  raw: Record<string, unknown>,
  deviceNames: Map<string, string>
): RecentUsageEvent | null {
  const ts = typeof raw.ts === 'string' ? raw.ts : null;
  const toolName = typeof raw.toolName === 'string' ? raw.toolName : null;
  if (!ts || !toolName) return null;

  let outcome: RecentUsageEvent['outcome'];
  let callType: RecentUsageEvent['callType'];
  let durationMs: number | undefined;

  switch (raw.event) {
    case 'tool_completed':
      outcome = raw.ok === true ? 'success' : 'failed';
      callType = 'routed-device';
      if (typeof raw.durationMs === 'number') durationMs = raw.durationMs;
      break;
    case 'gateway_tool':
      outcome = raw.ok === true ? 'success' : 'failed';
      callType = 'gateway-local';
      break;
    case 'tool_rejected_policy':
      outcome = 'rejected';
      callType = 'routed-device';
      break;
    case 'tool_timeout':
      outcome = 'timeout';
      callType = 'routed-device';
      break;
    case 'tool_abandoned_shutdown':
    case 'tool_abandoned_restart':
      outcome = 'abandoned';
      callType = 'routed-device';
      break;
    default:
      return null;
  }

  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : undefined;
  const client = typeof raw.client === 'string' && raw.client.trim()
    ? raw.client.trim()
    : 'legacy-unknown';
  const event: RecentUsageEvent = {
    ts,
    toolName,
    client,
    outcome,
    callType
  };
  if (deviceId) {
    event.deviceId = deviceId;
    event.deviceName = deviceNames.get(deviceId);
  }
  if (typeof raw.callId === 'string') event.callId = raw.callId;
  if (durationMs !== undefined) event.durationMs = durationMs;
  if (typeof raw.reason === 'string') event.reason = raw.reason;
  return event;
}
function aggregateRecentEvent(aggregate: DayAggregate, event: RecentUsageEvent): void {
  const successful = event.outcome === 'success';
  addTerminalEvent(
    aggregate,
    event.toolName,
    event.client,
    successful,
    event.callType,
    event.outcome,
    event.durationMs
  );
  const date = new Date(event.ts);
  recordHour(aggregate, date.getHours(), successful);
}

export class UsageAnalyticsService {
  private cache: UsageSnapshot | null = null;

  constructor(private readonly auditPath: string) {}

  async summary(range: UsageRange = 'all'): Promise<{
    generatedAt: string;
    timezone: string;
    range: UsageRange;
    malformedLines: number;
    counters: UsageCounters;
  }> {
    const snapshot = await this.snapshot();
    const aggregate = this.aggregateForRange(snapshot, range);
    return {
      generatedAt: snapshot.generatedAt,
      timezone: snapshot.timezone,
      range,
      malformedLines: snapshot.malformedLines,
      counters: normalizeCounters(aggregate.counters)
    };
  }

  async tools(range: UsageRange = 'all', limit = 25): Promise<{
    generatedAt: string;
    timezone: string;
    range: UsageRange;
    tools: ToolUsageRow[];
  }> {
    const snapshot = await this.snapshot();
    const aggregate = this.aggregateForRange(snapshot, range);
    const tools = [...aggregate.tools.entries()]
      .map(([toolName, row]) => ({ toolName, ...row }))
      .sort((a, b) => b.calls - a.calls || a.toolName.localeCompare(b.toolName))
      .slice(0, Math.max(1, Math.min(limit, 100)));
    return { generatedAt: snapshot.generatedAt, timezone: snapshot.timezone, range, tools };
  }

  async clients(range: UsageRange = 'all'): Promise<{
    generatedAt: string;
    timezone: string;
    range: UsageRange;
    clients: ClientUsageRow[];
  }> {
    const snapshot = await this.snapshot();
    const aggregate = this.aggregateForRange(snapshot, range);
    const clients = [...aggregate.clients.entries()]
      .map(([client, row]) => ({ client, ...row }))
      .sort((a, b) => b.calls - a.calls || a.client.localeCompare(b.client));
    return { generatedAt: snapshot.generatedAt, timezone: snapshot.timezone, range, clients };
  }

  async activity(range: UsageRange = 'today'): Promise<{
    generatedAt: string;
    timezone: string;
    range: UsageRange;
    hours: HourBucket[];
  }> {
    const snapshot = await this.snapshot();
    const aggregate = this.aggregateForRange(snapshot, range);
    const hours: HourBucket[] = Array.from({ length: 24 }, (_, hour) => {
      const row = aggregate.hours.get(hour) ?? { calls: 0, successful: 0, failed: 0 };
      return {
        hour,
        label: `${String(hour).padStart(2, '0')}:00`,
        ...row
      };
    });
    return { generatedAt: snapshot.generatedAt, timezone: snapshot.timezone, range, hours };
  }

  async recentEvents(limit = 50): Promise<{
    generatedAt: string;
    timezone: string;
    events: RecentUsageEvent[];
  }> {
    const snapshot = await this.snapshot();
    return {
      generatedAt: snapshot.generatedAt,
      timezone: snapshot.timezone,
      events: snapshot.recentEvents.slice(0, Math.max(1, Math.min(limit, 200)))
    };
  }
  private aggregateForRange(snapshot: UsageSnapshot, range: UsageRange): DayAggregate {
    if (range === 'all') return snapshot.all;

    const now = new Date();
    if (range === 'today') {
      return snapshot.days.get(localDayKey(now)) ?? emptyAggregate();
    }

    const monthPrefix = localMonthKey(now) + '-';
    const aggregate = emptyAggregate();
    for (const [day, dayAggregate] of snapshot.days) {
      if (day.startsWith(monthPrefix)) mergeAggregate(aggregate, dayAggregate);
    }
    return aggregate;
  }

  private async snapshot(): Promise<UsageSnapshot> {
    let stat;
    try {
      stat = await fsp.stat(this.auditPath);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        const empty: UsageSnapshot = {
          generatedAt: new Date().toISOString(),
          sourceMtimeMs: 0,
          sourceSize: 0,
          malformedLines: 0,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          all: emptyAggregate(),
          days: new Map(),
          recentEvents: []
        };
        this.cache = empty;
        return empty;
      }
      throw error;
    }

    if (
      this.cache
      && this.cache.sourceMtimeMs === stat.mtimeMs
      && this.cache.sourceSize === stat.size
    ) {
      return this.cache;
    }

    const all = emptyAggregate();
    const days = new Map<string, DayAggregate>();
    const recentEvents: RecentUsageEvent[] = [];
    const deviceNames = new Map<string, string>();
    let malformedLines = 0;

    const input = fs.createReadStream(this.auditPath, { encoding: 'utf8' });
    const lines = readline.createInterface({
      input,
      crlfDelay: Infinity
    });

    for await (const line of lines) {
      if (!line.trim()) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        malformedLines++;
        continue;
      }

      if (raw.event === 'device_registered') {
        if (typeof raw.deviceId === 'string' && typeof raw.deviceName === 'string') {
          deviceNames.set(raw.deviceId, raw.deviceName);
        }
        continue;
      }

      const event = eventFromAudit(raw, deviceNames);
      if (!event) continue;
      const date = validDate(event.ts);
      if (!date) {
        malformedLines++;
        continue;
      }

      aggregateRecentEvent(all, event);
      const dayKey = localDayKey(date);
      const day = days.get(dayKey) ?? emptyAggregate();
      aggregateRecentEvent(day, event);
      days.set(dayKey, day);

      recentEvents.unshift(event);
      if (recentEvents.length > RECENT_EVENT_LIMIT) recentEvents.pop();
    }

    recentEvents.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    if (recentEvents.length > RECENT_EVENT_LIMIT) {
      recentEvents.length = RECENT_EVENT_LIMIT;
    }

    const snapshot: UsageSnapshot = {
      generatedAt: new Date().toISOString(),
      sourceMtimeMs: stat.mtimeMs,
      sourceSize: stat.size,
      malformedLines,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      all,
      days,
      recentEvents
    };
    this.cache = snapshot;
    return snapshot;
  }
}

export function parseUsageRange(value: unknown): UsageRange {
  return value === 'today' || value === 'month' || value === 'all' ? value : 'all';
}

export function parseUsageLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), 200));
}
