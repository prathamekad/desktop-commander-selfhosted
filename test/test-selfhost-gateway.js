import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ownerToken = 'owner-' + 'a'.repeat(48);
const deviceToken = 'device-' + 'b'.repeat(48);

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child) {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`gateway exited early: ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('gateway did not become healthy');
}

async function postJson(url, token, body) {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-selfhost-test-'));
const auditPath = path.join(tempDir, 'audit.jsonl');
const orphanId = 'orphan-before-restart';

await fs.writeFile(auditPath, JSON.stringify({
  ts: new Date().toISOString(),
  event: 'tool_dispatched',
  callId: orphanId,
  deviceId: 'old-device',
  toolName: 'write_file'
}) + os.EOL);

const child = spawn(process.execPath, ['dist/selfhost/gateway.js'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SELFHOST_HOST: '127.0.0.1',
    SELFHOST_PORT: String(port),
    SELFHOST_OWNER_TOKEN: ownerToken,
    SELFHOST_DEVICE_TOKEN: deviceToken,
    SELFHOST_AUDIT_LOG: auditPath,
    SELFHOST_ALLOWED_ROOTS: 'C:\\SelfhostTest'
  }
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  await waitForHealth(baseUrl, child);

  const auditAfterStart = await fs.readFile(auditPath, 'utf8');
  assert.match(auditAfterStart, /tool_abandoned_restart/);
  assert.match(auditAfterStart, new RegExp(orphanId));

  const unauthorized = await fetch(`${baseUrl}/api/devices`);
  assert.equal(unauthorized.status, 401);

  const registration = await postJson(`${baseUrl}/api/device/register`, deviceToken, {
    deviceId: 'test-device',
    deviceName: 'Test Device',
    version: 'test',
    tools: [
      {
        name: 'echo_selfhost_test',
        description: 'Echo a value',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value']
        },
        _meta: {
          'ui/resourceUri': 'ui://desktop-commander/file-preview',
          'openai/outputTemplate': 'ui://desktop-commander/file-preview',
          'openai/widgetAccessible': true,
          ui: { resourceUri: 'ui://desktop-commander/file-preview' },
          customMarker: 'keep-me'
        }
      },
      {
        name: 'start_process',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout_ms: { type: 'number' }
          },
          required: ['command', 'timeout_ms']
        }
      },
      {
        name: 'read_process_output',
        inputSchema: {
          type: 'object',
          properties: { pid: { type: 'number' } },
          required: ['pid']
        }
      },
      {
        name: 'set_config_value',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: {}
          },
          required: ['key', 'value']
        }
      }
    ]
  });
  assert.equal(registration.status, 200);
  const pollPromise = postJson(`${baseUrl}/api/device/poll`, deviceToken, {
    deviceId: 'test-device',
    timeoutMs: 10_000
  });

  const client = new Client(
    { name: 'selfhost-integration-test', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${ownerToken}` } } }
  );
  await client.connect(transport);

  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === 'echo_selfhost_test'));
  assert.ok(listed.tools.some((tool) => tool.name === 'selfhost_list_devices'));
  assert.ok(listed.tools.some((tool) => tool.name === 'start_shutdown_watch'));
  assert.ok(listed.tools.some((tool) => tool.name === 'get_shutdown_watch_status'));
  assert.ok(listed.tools.some((tool) => tool.name === 'stop_shutdown_watch'));
  assert.ok(listed.tools.some((tool) => tool.name === 'shutdown'));
  assert.ok(listed.tools.some((tool) => tool.name === 'cancel_shutdown'));
  assert.ok(listed.tools.some((tool) => tool.name === 'start_process'));
  assert.equal(listed.tools.some((tool) => tool.name === 'set_config_value'), false);

  const echoTool = listed.tools.find((tool) => tool.name === 'echo_selfhost_test');
  assert.ok(echoTool);
  assert.equal(echoTool._meta?.['ui/resourceUri'], undefined);
  assert.equal(echoTool._meta?.['openai/outputTemplate'], undefined);
  assert.equal(echoTool._meta?.['openai/widgetAccessible'], undefined);
  assert.equal(echoTool._meta?.ui, undefined);
  assert.equal(echoTool._meta?.customMarker, undefined);
  assert.deepEqual(echoTool._meta?.securitySchemes, [{ type: 'oauth2', scopes: ['mcp:tools'] }]);

  const devices = await client.callTool({
    name: 'selfhost_list_devices',
    arguments: {}
  });
  assert.equal(devices.isError, undefined);

  const unowned = await client.callTool({
    name: 'read_process_output',
    arguments: { pid: 999999 }
  });
  assert.equal(unowned.isError, true);
  assert.match(unowned.content[0].text, /not owned/i);

  const callPromise = client.callTool({
    name: 'echo_selfhost_test',
    arguments: { value: 'hello' }
  });

  const pollResponse = await pollPromise;
  assert.equal(pollResponse.status, 200);
  const { call } = await pollResponse.json();
  assert.equal(call.toolName, 'echo_selfhost_test');
  assert.equal(call.args.value, 'hello');

  const resultResponse = await postJson(`${baseUrl}/api/device/result`, deviceToken, {
    callId: call.callId,
    deviceId: 'test-device',
    ok: true,
    result: {
      content: [{ type: 'text', text: 'hello' }],
      structuredContent: { preview: 'must-not-escape' },
      _meta: { 'openai/outputTemplate': 'ui://desktop-commander/file-preview', custom: 'must-not-escape' }
    }
  });
  assert.equal(resultResponse.status, 200);

  const result = await callPromise;
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'hello');
  assert.equal(result.structuredContent, undefined);
  assert.equal(result._meta, undefined);

  const processPollPromise = postJson(`${baseUrl}/api/device/poll`, deviceToken, {
    deviceId: 'test-device',
    timeoutMs: 10_000
  });
  const startPromise = client.callTool({
    name: 'start_process',
    arguments: { command: 'npm test', timeout_ms: 1_000 }
  });
  const processPollResponse = await processPollPromise;
  const { call: processCall } = await processPollResponse.json();
  assert.equal(processCall.toolName, 'start_process');
  assert.equal(
    processCall.args.command,
    "Set-Location -LiteralPath 'C:\\SelfhostTest'; npm test"
  );

  await postJson(`${baseUrl}/api/device/result`, deviceToken, {
    callId: processCall.callId,
    deviceId: 'test-device',
    ok: true,
    result: {
      content: [{ type: 'text', text: 'Process started with PID 4242 (shell: powershell.exe)' }]
    }
  });
  const started = await startPromise;
  assert.equal(started.isError, undefined);

  const outputPollPromise = postJson(`${baseUrl}/api/device/poll`, deviceToken, {
    deviceId: 'test-device',
    timeoutMs: 10_000
  });
  const outputPromise = client.callTool({
    name: 'read_process_output',
    arguments: { pid: 4242 }
  });
  const outputPollResponse = await outputPollPromise;
  const { call: outputCall } = await outputPollResponse.json();
  assert.equal(outputCall.toolName, 'read_process_output');
  assert.equal(outputCall.args.pid, 4242);

  await postJson(`${baseUrl}/api/device/result`, deviceToken, {
    callId: outputCall.callId,
    deviceId: 'test-device',
    ok: true,
    result: { content: [{ type: 'text', text: 'done' }] }
  });
  const outputResult = await outputPromise;
  assert.equal(outputResult.isError, undefined);

  await client.close();

  const unauthorizedUsage = await fetch(`${baseUrl}/api/usage/summary?range=all`);
  assert.equal(unauthorizedUsage.status, 401);

  const usageSummaryResponse = await fetch(
    `${baseUrl}/api/usage/summary?range=all`,
    { headers: { authorization: `Bearer ${ownerToken}` } }
  );
  assert.equal(usageSummaryResponse.status, 200);
  const usageSummary = await usageSummaryResponse.json();
  assert.ok(usageSummary.counters.totalCalls >= 5);
  assert.ok(usageSummary.counters.successfulCalls >= 4);
  assert.ok(usageSummary.counters.failedCalls >= 1);

  const usageToolsResponse = await fetch(
    `${baseUrl}/api/usage/tools?range=all&limit=10`,
    { headers: { authorization: `Bearer ${ownerToken}` } }
  );
  assert.equal(usageToolsResponse.status, 200);
  const usageTools = await usageToolsResponse.json();
  assert.ok(usageTools.tools.some((row) => row.toolName === 'selfhost_list_devices'));

  const usageClientsResponse = await fetch(
    `${baseUrl}/api/usage/clients?range=all`,
    { headers: { authorization: `Bearer ${ownerToken}` } }
  );
  assert.equal(usageClientsResponse.status, 200);
  const usageClients = await usageClientsResponse.json();
  assert.ok(usageClients.clients.some((row) => row.client === 'local-owner'));

  const usageActivityResponse = await fetch(
    `${baseUrl}/api/usage/activity?range=today`,
    { headers: { authorization: `Bearer ${ownerToken}` } }
  );
  assert.equal(usageActivityResponse.status, 200);
  const usageActivity = await usageActivityResponse.json();
  assert.equal(usageActivity.hours.length, 24);

  const usageEventsResponse = await fetch(
    `${baseUrl}/api/usage/events?limit=3`,
    { headers: { authorization: `Bearer ${ownerToken}` } }
  );
  assert.equal(usageEventsResponse.status, 200);
  const usageEvents = await usageEventsResponse.json();
  assert.equal(usageEvents.events.length, 3);

  const audit = await fs.readFile(auditPath, 'utf8');
  assert.match(audit, /tool_dispatched/);
  assert.match(audit, /tool_completed/);
  assert.match(audit, /gateway_tool/);
  assert.match(audit, /tool_rejected_policy/);
  assert.match(audit, /"client":"local-owner"/);
  console.log('selfhost gateway integration: PASS');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill();
  await fs.rm(tempDir, { recursive: true, force: true });
  if (stderr.trim()) process.stderr.write(stderr);
}
