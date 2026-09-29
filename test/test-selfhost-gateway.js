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
    SELFHOST_AUDIT_LOG: auditPath
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
    tools: [{
      name: 'echo_selfhost_test',
      description: 'Echo a value',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value']
      }
    }]
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
    result: { content: [{ type: 'text', text: 'hello' }] }
  });
  assert.equal(resultResponse.status, 200);

  const result = await callPromise;
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'hello');
  await client.close();

  const audit = await fs.readFile(auditPath, 'utf8');
  assert.match(audit, /tool_dispatched/);
  assert.match(audit, /tool_completed/);
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
