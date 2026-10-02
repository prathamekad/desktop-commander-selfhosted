import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  UsageAnalyticsService,
  parseUsageLimit,
  parseUsageRange
} from '../dist/selfhost/usage-analytics.js';

function isoAt(date, hour, minute = 0) {
  const copy = new Date(date);
  copy.setHours(hour, minute, 0, 0);
  return copy.toISOString();
}

const now = new Date();
const priorMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 10, 0, 0, 0);
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-usage-test-'));
const auditPath = path.join(tempDir, 'audit.jsonl');

const rows = [
  { ts: isoAt(now, 7), event: 'device_registered', deviceId: 'home-1', deviceName: 'Home', toolCount: 26 },
  { ts: isoAt(now, 8), event: 'tool_completed', callId: 'a', deviceId: 'home-1', toolName: 'get_config', client: 'chatgpt', ok: true, durationMs: 100 },
  { ts: isoAt(now, 8, 10), event: 'gateway_tool', toolName: 'selfhost_list_devices', client: 'chatgpt', ok: true, deviceCount: 1 },
  { ts: isoAt(now, 9), event: 'tool_completed', callId: 'b', deviceId: 'home-1', toolName: 'read_file', client: 'claude', ok: false, durationMs: 200 },
  { ts: isoAt(now, 10), event: 'tool_rejected_policy', deviceId: 'home-1', toolName: 'read_file', client: 'claude', reason: 'path_outside_allowed_roots' },
  { ts: isoAt(now, 11), event: 'tool_timeout', callId: 'c', deviceId: 'home-1', toolName: 'start_process' },
  { ts: isoAt(now, 12), event: 'tool_abandoned_restart', callId: 'd', deviceId: 'home-1', toolName: 'write_file', reason: 'gateway_restarted_before_terminal_receipt' },
  { ts: priorMonth.toISOString(), event: 'tool_completed', callId: 'old', deviceId: 'home-1', toolName: 'get_config', ok: true, durationMs: 50 }
];

await fs.writeFile(
  auditPath,
  rows.map((row) => JSON.stringify(row)).join(os.EOL) + os.EOL + '{bad-json' + os.EOL,
  'utf8'
);

try {
  const usage = new UsageAnalyticsService(auditPath);

  const today = await usage.summary('today');
  assert.equal(today.counters.totalCalls, 6);
  assert.equal(today.counters.successfulRouted, 1);
  assert.equal(today.counters.successfulGatewayLocal, 1);
  assert.equal(today.counters.failedRouted, 1);
  assert.equal(today.counters.policyRejected, 1);
  assert.equal(today.counters.timeouts, 1);
  assert.equal(today.counters.abandonedUnknown, 1);
  assert.equal(today.counters.successfulCalls, 2);
  assert.equal(today.counters.failedCalls, 4);
  assert.equal(today.counters.successRate, 33.33);
  assert.equal(today.counters.averageRoutedDurationMs, 150);
  assert.equal(today.malformedLines, 1);

  const all = await usage.summary('all');
  assert.equal(all.counters.totalCalls, 7);
  assert.equal(all.counters.successfulRouted, 2);
  assert.equal(all.counters.successfulCalls, 3);
  assert.equal(all.counters.averageRoutedDurationMs, 117);

  const tools = await usage.tools('today');
  assert.deepEqual(
    tools.tools.map((row) => [row.toolName, row.calls]),
    [
      ['read_file', 2],
      ['get_config', 1],
      ['selfhost_list_devices', 1],
      ['start_process', 1],
      ['write_file', 1]
    ]
  );

  const clients = await usage.clients('today');
  assert.deepEqual(
    clients.clients.map((row) => [row.client, row.calls]),
    [
      ['chatgpt', 2],
      ['claude', 2],
      ['legacy-unknown', 2]
    ]
  );

  const activity = await usage.activity('today');
  assert.equal(activity.hours.length, 24);
  assert.equal(activity.hours[8].calls, 2);
  assert.equal(activity.hours[8].successful, 2);
  assert.equal(activity.hours[9].failed, 1);

  const recent = await usage.recentEvents(3);
  assert.equal(recent.events.length, 3);
  assert.equal(recent.events[0].toolName, 'write_file');
  assert.equal(recent.events[0].outcome, 'abandoned');
  assert.equal(recent.events[0].deviceName, 'Home');
  assert.equal(recent.events[1].toolName, 'start_process');
  assert.equal(recent.events[1].outcome, 'timeout');

  assert.equal(parseUsageRange('today'), 'today');
  assert.equal(parseUsageRange('garbage'), 'all');
  assert.equal(parseUsageLimit('9999', 25), 200);
  assert.equal(parseUsageLimit('bad', 25), 25);

  // Cache invalidation: append a new terminal event and confirm totals change.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.appendFile(
    auditPath,
    JSON.stringify({
      ts: isoAt(now, 13),
      event: 'gateway_tool',
      toolName: 'selfhost_list_devices',
      ok: true
    }) + os.EOL,
    'utf8'
  );
  const afterAppend = await usage.summary('today');
  assert.equal(afterAppend.counters.totalCalls, 7);

  console.log('selfhost usage analytics: PASS');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
